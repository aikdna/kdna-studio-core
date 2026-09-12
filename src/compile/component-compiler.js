'use strict';
const {encodeComponentRuntime}=require('./component-encoding');
// Compiler only serializes its private clone; it never owns expected context.
function compileComponentMaterial(plan){return encodeComponentRuntime(plan);}
module.exports={compileComponentMaterial};
