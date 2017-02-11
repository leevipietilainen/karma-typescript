import * as async from "async";
import * as lodash from "lodash";
import { Logger } from "log4js";
import * as ts from "typescript";

import Benchmark =  require("./benchmark");
import { Configuration } from "./configuration";
import { File } from "./file";

type CompiledFiles = { [key: string]: string; };

type Queued = {
    file: File;
    callback: Function;
    requiredModules?: any[];
};

class Compiler {

    private readonly COMPILE_DELAY = 200;

    private config: Configuration;

    private cachedProgram: ts.Program;
    private compiledFiles: CompiledFiles = {};
    private compilerHost: ts.CompilerHost;
    private emitQueue: Queued[] = [];
    private hostGetSourceFile: Function;
    private log: Logger;
    private program: ts.Program;
    private requiredModuleCounter: number;
    private tsconfig: ts.ParsedCommandLine;
    private deferredCompile = lodash.debounce(() => {

        this.compileProgram(this.onProgramCompiled);

    }, this.COMPILE_DELAY);

    constructor(config: Configuration) {
        this.config = config;
    }

    public initialize(logger: any, tsconfig: ts.ParsedCommandLine) {

        this.tsconfig = tsconfig;
        this.log = logger.create("compiler.karma-typescript");

        this.log.info("Compiling project using Typescript %s", ts.version);

        this.outputDiagnostics(tsconfig.errors);
    }

    public getModuleFormat(): string {
        return ts.ModuleKind[this.tsconfig.options.module] || "unknown";
    }

    public getRequiredModulesCount(): number {
        return this.requiredModuleCounter;
    }

    public compile(file: any, callback: Function) {

        this.emitQueue.push({
            file,
            callback
        });

        this.deferredCompile();
    }

    private onProgramCompiled = () => {

        this.emitQueue.forEach((queued) => {

            let sourceFile = this.program.getSourceFile(queued.file.originalPath);

            if (!sourceFile) {
                throw new Error("No source found for " + queued.file.originalPath + "!\n" +
                                "Is there a mismatch between the Typescript compiler options and the Karma config?");
            }

            queued.callback({
                isDeclarationFile: (<any> ts).isDeclarationFile(sourceFile),
                outputText: this.compiledFiles[queued.file.path],
                requiredModules: queued.requiredModules,
                sourceMapText: this.compiledFiles[queued.file.path + ".map"]
            });
        });

        this.emitQueue.length = 0;
    }

    private compileProgram(onProgramCompiled: Function) {

        let benchmark = new Benchmark();

        if (!this.cachedProgram) {
            this.compilerHost = ts.createCompilerHost(this.tsconfig.options);
            this.hostGetSourceFile = this.compilerHost.getSourceFile;
            this.compilerHost.getSourceFile = this.getSourceFile;
            this.compilerHost.writeFile = (filename, text) => {
                this.compiledFiles[filename] = text;
            };
        }

        this.program = ts.createProgram(this.tsconfig.fileNames, this.tsconfig.options, this.compilerHost);
        this.cachedProgram = this.program;

        this.runDiagnostics(this.program, this.compilerHost);

        this.program.emit();

        this.applyTransforms(() => {
            this.log.info("Compiled %s files in %s ms.", this.tsconfig.fileNames.length, benchmark.elapsed());
            this.collectRequiredModules();
            onProgramCompiled();
        });
    }

    private getSourceFile = (filename: string, languageVersion: ts.ScriptTarget) => {

        if (this.cachedProgram && !this.isQueued(filename)) {
            let sourceFile = this.cachedProgram.getSourceFile(filename);
            if (sourceFile) {
                return sourceFile;
            }
        }

        return this.hostGetSourceFile(filename, languageVersion);
    }

    private isQueued(filename: string) {
        for (let queued of this.emitQueue) {
            if (queued.file.originalPath === filename) {
                return true;
            }
        }
        return false;
    }

    private applyTransforms(onTransformssApplied: ErrorCallback<Error>) {

        if (!this.config.transforms.length) {
            process.nextTick(() => {
                onTransformssApplied();
            });
            return;
        }

        async.eachSeries(this.emitQueue, (queued: Queued, onQueueProcessed: ErrorCallback<Error>) => {
            let sourceFile = this.program.getSourceFile(queued.file.originalPath);
            let context = {
                basePath: this.config.karma.basePath,
                filename: queued.file.originalPath,
                fullText: sourceFile.getFullText(),
                sourceFile,
                urlRoot: this.config.karma.urlRoot
            };
            async.eachSeries(this.config.transforms, (transform: Function, onTransformApplied: Function) => {
                process.nextTick(() => {
                    transform(context, (changed: boolean) => {
                        if (changed) {
                            let transpiled = ts.transpileModule(context.fullText, {
                                compilerOptions: this.tsconfig.options,
                                fileName: queued.file.originalPath
                            });
                            this.compiledFiles[queued.file.path] = transpiled.outputText;
                            this.compiledFiles[queued.file.path + ".map"] = transpiled.sourceMapText;
                        }
                        onTransformApplied();
                    });
                });
            }, onQueueProcessed);
        }, onTransformssApplied);
    }

    private runDiagnostics(program: ts.Program, host: ts.CompilerHost) {
        let diagnostics = ts.getPreEmitDiagnostics(program);
        this.outputDiagnostics(diagnostics, host);
    }

    private outputDiagnostics(diagnostics: ts.Diagnostic[], host?: ts.FormatDiagnosticsHost) {

        if (diagnostics && diagnostics.length > 0) {

            diagnostics.forEach((diagnostic) => {

                if (ts.formatDiagnostics) { // v1.8+
                    this.log.error(ts.formatDiagnostics([diagnostic], host));
                }
                else { // v1.6, v1.7

                    let output = "";

                    if (diagnostic.file) {
                        let loc = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start);
                        output += diagnostic.file.fileName.replace(process.cwd(), "") + "(" + (loc.line + 1) + "," + (loc.character + 1) + "): ";
                    }

                    let category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
                    output += category + " TS" + diagnostic.code + ": " + ts.flattenDiagnosticMessageText(diagnostic.messageText, ts.sys.newLine) + ts.sys.newLine;

                    this.log.error(output);
                }
            });

            if (this.tsconfig.options.noEmitOnError) {
                ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
            }
        }
    }

    private collectRequiredModules() {

        this.requiredModuleCounter = 0;

        this.emitQueue.forEach((queued) => {

            let sourceFile = this.program.getSourceFile(queued.file.originalPath);
            queued.requiredModules = this.findUnresolvedRequires(sourceFile);

            if ((<any> sourceFile).resolvedModules && !sourceFile.isDeclarationFile) {

                Object.keys((<any> sourceFile).resolvedModules).forEach((moduleName) => {

                    let resolvedModule = (<any> sourceFile).resolvedModules[moduleName];

                    queued.requiredModules.push({
                        filename: resolvedModule && resolvedModule.resolvedFileName,
                        isTypescriptFile: this.isTypescriptFile(resolvedModule),
                        isTypingsFile: this.isTypingsFile(resolvedModule),
                        moduleName
                    });
                });
            }

            this.requiredModuleCounter += queued.requiredModules.length;
        });
    }

    private findUnresolvedRequires(sourceFile: ts.SourceFile) {

        let requiredModules: any[] = [];

        if ((<any> ts).isDeclarationFile(sourceFile)) {
            return requiredModules;
        }

        let visitNode = (node: ts.Node) => {

            if (node.kind === ts.SyntaxKind.CallExpression) {

                let ce = (<ts.CallExpression> node);

                let expression = ce.expression ?
                    (<ts.LiteralExpression> ce.expression) :
                    undefined;

                let argument = ce.arguments && ce.arguments.length ?
                    (<ts.LiteralExpression> ce.arguments[0]) :
                    undefined;

                if (expression && expression.text === "require" &&
                    argument && typeof argument.text === "string") {

                    requiredModules.push({
                        filename: undefined,
                        isTypescriptFile: undefined,
                        isTypingsFile: undefined,
                        moduleName: argument.text
                    });
                }
            }

            ts.forEachChild(node, visitNode);
        };

        visitNode(sourceFile);

        return requiredModules;
    }

    private isTypingsFile(resolvedModule: any) {
        return resolvedModule &&
               /\.d\.ts$/.test(resolvedModule.resolvedFileName);
    }

    private isTypescriptFile(resolvedModule: any) {
        return resolvedModule &&
               !this.isTypingsFile(resolvedModule) &&
               /\.(ts|tsx)$/.test(resolvedModule.resolvedFileName);
    }
}

module.exports = Compiler;
