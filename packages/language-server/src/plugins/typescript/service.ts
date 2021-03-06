import { dirname, resolve } from 'path';
import ts from 'typescript';
import { Document } from '../../lib/documents';
import { Logger } from '../../logger';
import { getPackageInfo } from '../importPackage';
import { DocumentSnapshot } from './DocumentSnapshot';
import { createSvelteModuleLoader } from './module-loader';
import { SnapshotManager } from './SnapshotManager';
import { ensureRealSvelteFilePath, findTsConfigPath, isSvelteFilePath } from './utils';

export interface LanguageServiceContainer {
    readonly tsconfigPath: string;
    readonly compilerOptions: ts.CompilerOptions;
    getService(): ts.LanguageService;
    updateDocument(document: Document): ts.LanguageService;
    deleteDocument(filePath: string): void;
}

const services = new Map<string, LanguageServiceContainer>();

export type CreateDocument = (fileName: string, content: string) => Document;

export function getLanguageServiceForPath(
    path: string,
    workspacePath: string,
    createDocument: CreateDocument,
): ts.LanguageService {
    return getService(path, workspacePath, createDocument).getService();
}

export function getLanguageServiceForDocument(
    document: Document,
    workspacePath: string,
    createDocument: CreateDocument,
): ts.LanguageService {
    return getService(document.getFilePath() || '', workspacePath, createDocument).updateDocument(
        document,
    );
}

export function getService(path: string, workspacePath: string, createDocument: CreateDocument) {
    const tsconfigPath = findTsConfigPath(path, workspacePath);

    let service: LanguageServiceContainer;
    if (services.has(tsconfigPath)) {
        service = services.get(tsconfigPath)!;
    } else {
        Logger.log('Initialize new ts service at ', tsconfigPath);
        service = createLanguageService(tsconfigPath, createDocument);
        services.set(tsconfigPath, service);
    }

    return service;
}

export function createLanguageService(
    tsconfigPath: string,
    createDocument: CreateDocument,
): LanguageServiceContainer {
    const workspacePath = tsconfigPath ? dirname(tsconfigPath) : '';
    const snapshotManager = SnapshotManager.getFromTsConfigPath(tsconfigPath);
    const sveltePkgInfo = getPackageInfo('svelte', workspacePath);

    const { compilerOptions, files } = getCompilerOptionsAndRootFiles();

    const svelteModuleLoader = createSvelteModuleLoader(getSnapshot, compilerOptions);

    const svelteTsPath = dirname(require.resolve('svelte2tsx'));
    const svelteTsxFiles = ['./svelte-shims.d.ts', './svelte-jsx.d.ts'].map((f) =>
        ts.sys.resolvePath(resolve(svelteTsPath, f)),
    );

    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () =>
            Array.from(new Set([...files, ...snapshotManager.getFileNames(), ...svelteTsxFiles])),
        getScriptVersion: (fileName: string) => getSnapshot(fileName).version.toString(),
        getScriptSnapshot: getSnapshot,
        getCurrentDirectory: () => workspacePath,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: svelteModuleLoader.fileExists,
        readFile: svelteModuleLoader.readFile,
        resolveModuleNames: svelteModuleLoader.resolveModuleNames,
        readDirectory: ts.sys.readDirectory,
        getDirectories: ts.sys.getDirectories,
        // vscode's uri is all lowercase
        useCaseSensitiveFileNames: () => false,
        getScriptKind: (fileName: string) => getSnapshot(fileName).scriptKind,
    };
    let languageService = ts.createLanguageService(host);

    return {
        tsconfigPath,
        compilerOptions,
        getService: () => languageService,
        updateDocument,
        deleteDocument,
    };

    function deleteDocument(filePath: string): void {
        svelteModuleLoader.deleteFromModuleCache(filePath);
        snapshotManager.delete(filePath);
    }

    function updateDocument(document: Document): ts.LanguageService {
        const preSnapshot = snapshotManager.get(document.getFilePath()!);

        // Don't reinitialize document if no update needed.
        if (preSnapshot?.version === document.version) {
            return languageService;
        }

        const newSnapshot = DocumentSnapshot.fromDocument(document, {
            strictMode: !!compilerOptions.strict,
        });
        if (preSnapshot && preSnapshot.scriptKind !== newSnapshot.scriptKind) {
            // Restart language service as it doesn't handle script kind changes.
            languageService.dispose();
            languageService = ts.createLanguageService(host);
        }

        snapshotManager.set(document.getFilePath()!, newSnapshot);
        return languageService;
    }

    function getSnapshot(fileName: string): DocumentSnapshot {
        fileName = ensureRealSvelteFilePath(fileName);

        let doc = snapshotManager.get(fileName);
        if (doc) {
            return doc;
        }

        if (isSvelteFilePath(fileName)) {
            const file = ts.sys.readFile(fileName) || '';
            doc = DocumentSnapshot.fromDocument(createDocument(fileName, file), {
                strictMode: !!compilerOptions.strict,
            });
        } else {
            doc = DocumentSnapshot.fromFilePath(fileName, { strictMode: !!compilerOptions.strict });
        }

        snapshotManager.set(fileName, doc);
        return doc;
    }

    function getCompilerOptionsAndRootFiles() {
        let compilerOptions: ts.CompilerOptions = {
            allowNonTsExtensions: true,
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            allowJs: true,
            types: [resolve(sveltePkgInfo.path, 'types', 'runtime')],
        };

        const configJson = tsconfigPath && ts.readConfigFile(tsconfigPath, ts.sys.readFile).config;
        let files: string[] = [];
        if (configJson) {
            const parsedConfig = ts.parseJsonConfigFileContent(
                configJson,
                ts.sys,
                workspacePath,
                compilerOptions,
                tsconfigPath,
                undefined,
                [{ extension: 'svelte', isMixedContent: false, scriptKind: ts.ScriptKind.TSX }],
            );

            compilerOptions = { ...compilerOptions, ...parsedConfig.options };
            files = parsedConfig.fileNames;
        }

        const forcedOptions: ts.CompilerOptions = {
            noEmit: true,
            declaration: false,
            skipLibCheck: true,
            // these are needed to handle the results of svelte2tsx preprocessing:
            jsx: ts.JsxEmit.Preserve,
            jsxFactory: 'h',
        };
        compilerOptions = { ...compilerOptions, ...forcedOptions };

        return { compilerOptions, files };
    }
}
