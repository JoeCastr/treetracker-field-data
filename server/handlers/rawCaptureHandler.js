const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { createTreesInMainDB, LegacyTree } = require('../models/LegacyTree');
const { createRawCapture, rawCaptureFromRequest, getRawCaptures }= require('../models/RawCapture');
const { dispatch } = require('../models/DomainEvent');

const Session = require('../infra/database/Session');
const { publishMessage } = require('../infra/messaging/RabbitMQMessaging');

const { RawCaptureRepository, EventRepository } = require('../infra/database/PgRepositories');
const { LegacyTreeRepository, LegacyTreeAttributeRepository }  = require('../infra/database/PgMigrationRepositories');

const rawCaptureGet = async (req, res) => {
    const session = new Session(false);
    const captureRepo = new RawCaptureRepository(session);
    const executeGetRawCaptures = getRawCaptures(captureRepo);
    const result = await executeGetRawCaptures(req.query);
    res.send(result);
    res.end();
};

const rawCapturePost = async (req, res) => {
    const session = new Session(false);
    const migrationSession = new Session(true);
    const captureRepo = new RawCaptureRepository(session);
    const eventRepository = new EventRepository(session);
    const legacyTreeRepository = new LegacyTreeRepository(migrationSession);
    const legacyTreeAttributeRepository = new LegacyTreeAttributeRepository(migrationSession);
    const executeCreateRawCapture = createRawCapture(captureRepo, eventRepository);
    const eventDispatch = dispatch(eventRepository, publishMessage);
    const legacyDataMigration = createTreesInMainDB(legacyTreeRepository, legacyTreeAttributeRepository);

    try {
        await migrationSession.beginTransaction();
        const { entity: tree } = await legacyDataMigration(LegacyTree({ ...req.body }), [ ...req.body.attributes ]);
        const rawCapture = rawCaptureFromRequest({id: tree.id, ...req.body});
        await session.beginTransaction();
        const { entity, raisedEvents } = await executeCreateRawCapture(rawCapture);
        await session.commitTransaction();       
        await migrationSession.commitTransaction();
        raisedEvents.forEach(domainEvent => eventDispatch(domainEvent));
        res.status(200).json({
            ...entity
        });
    } catch(e) {
        console.log(e);
        if (session.isTransactionInProgress()){
            await session.rollbackTransaction();
        }
        if (migrationSession.isTransactionInProgress()) {
            await migrationSession.rollbackTransaction();
        }
        let result = e;
        res.status(422).json({...result});
    }
};

module.exports = {
    rawCaptureGet,
    rawCapturePost
}