'use strict';
// One current graph and one current evidence format; old releases stay historical.
const {createComponentSession}=require('./creation-engine/component-session');
const {verifyCreationEvidence}=require('./evidence/component-evidence');
module.exports={createSession:createComponentSession,verifyCreationEvidence};
