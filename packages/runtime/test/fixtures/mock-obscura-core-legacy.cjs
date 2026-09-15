const core = require("./mock-obscura-core.cjs");
delete core.ObscuraCore.prototype.querySnapshot;
module.exports = core;
