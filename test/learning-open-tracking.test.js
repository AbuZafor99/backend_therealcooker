import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Learning } from "../model/learning.model.js";
import { OperationEvent } from "../model/operation.model.js";
import { getPublishedLearningById } from "../controller/learning.controller.js";

test("opening a module records who opened it, and the module response is unchanged", async () => {
  const state = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  const originals = { findOne: Learning.findOne, create: OperationEvent.create };
  const recorded = [];
  const doc = new Learning({ title: "OTP safety", description: "Never share an OTP", isPublished: true });
  Learning.findOne = () => ({ populate: async () => doc });
  OperationEvent.create = async data => { recorded.push(data); return data; };
  const open = user => new Promise((resolve, reject) => {
    const res = { status() { return this; }, json: resolve };
    getPublishedLearningById({ params: { id: String(doc._id) }, user, protocol: "https", get: () => "api.test" }, res, reject);
  });
  try {
    const signedIn = await open({ _id: "507f1f77bcf86cd799439011" });
    const anonymous = await open(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(signedIn, anonymous, "the response does not depend on who opened it");
    assert.equal(signedIn.data.title, "OTP safety");
    assert.deepEqual(recorded.map(event => [event.kind, event.entityId, event.user]), [["learning_opened", String(doc._id), "507f1f77bcf86cd799439011"], ["learning_opened", String(doc._id), undefined]]);
  } finally {
    Learning.findOne = originals.findOne; OperationEvent.create = originals.create;
    state ? Object.defineProperty(mongoose.connection, "readyState", state) : delete mongoose.connection.readyState;
  }
});
