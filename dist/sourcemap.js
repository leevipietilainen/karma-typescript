"use strict";
var path = require("path");
function create(file, source, emitOutput) {
    var result = emitOutput.outputText;
    var map;
    var datauri;
    if (emitOutput.sourceMapText) {
        map = JSON.parse(emitOutput.sourceMapText);
        map.sources[0] = path.basename(file.originalPath);
        map.sourcesContent = [source];
        map.file = path.basename(file.path);
        file.sourceMap = map;
        datauri = "data:application/json;charset=utf-8;base64," + new Buffer(JSON.stringify(map)).toString("base64");
        result = result.replace(this.getComment(file), "//# sourceMappingURL=" + datauri);
    }
    return result;
}
exports.create = create;
function getComment(file) {
    return "//# sourceMappingURL=" + path.basename(file.path) + ".map";
}
exports.getComment = getComment;
