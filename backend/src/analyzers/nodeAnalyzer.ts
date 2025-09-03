import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

const RX = {
    tableSequelizeTs: /@Table\s*\(\s*\{[^}]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/g,
    className: /export\s+class\s+(\w+)/g,
    entityTypeORM: /@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`]|\{\s*name\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\})\s*\)/g,
    prismaModelUse: /prisma\.(\w+)\.(findMany|findFirst|create|update|delete|upsert|aggregate|groupBy)/g,
    sqlTables: /(?:FROM|JOIN)\s+([a-zA-Z0-9_."\[\]]+)/gi,
    injectConnNamed: /@InjectConnection\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    sequelizeForRoot: /SequelizeModule\.forRoot\(\s*\{[\s\S]*?dialect\s*:\s*['"`](postgres|mssql)['"`][\s\S]*?\}\s*\)/g
};

function mapDialectToDb(dialect?: string): 'postgres'|'sqlserver'|undefined {
    if (!dialect) return;
    if (dialect.toLowerCase().includes('postgres')) return 'postgres';
    if (dialect.toLowerCase().includes('mssql') || dialect.toLowerCase().includes('sqlserver')) return 'sqlserver';
}

export function analyzeNodeModels(text: string, fileName: string): ModelInfo[] {
    const models: ModelInfo[] = [];
    const classNames: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = RX.className.exec(text))) classNames.push(m[1]);

    const sequelizeTables: Record<string, string> = {};
    while ((m = RX.tableSequelizeTs.exec(text))) {
        const table = m[1];
        const rest = text.slice(m.index);
        const classMatch = /export\s+class\s+(\w+)/.exec(rest);
        if (classMatch) sequelizeTables[classMatch[1]] = table;
    }

    const typeormTables: Record<string, string> = {};
    while ((m = RX.entityTypeORM.exec(text))) {
        const t = m[1] || m[2];
        const rest = text.slice(m.index);
        const cls = /export\s+class\s+(\w+)/.exec(rest)?.[1];
        if (t && cls) typeormTables[cls] = t;
    }

    for (const cls of classNames) {
        const tableName = sequelizeTables[cls] ?? typeormTables[cls];
        if (tableName) {
            models.push({ modelName: cls, tableName, relations: [] });
        }
    }

    const relMatches = [...text.matchAll(/@BelongsToMany\s*\(\s*\(\)\s*=>\s*(\w+)[\s\S]*?\(\)\s*=>\s*(\w+)/g)];
    for (const r of relMatches) {
        const target = r[1];
        const join = r[2];
        const last = models[models.length - 1];
        if (last) last.relations?.push({ via: 'BelongsToMany', target, joinTable: join });
    }

    return models;
}

export function analyzeNodeServices(
    text: string,
    fileName: string,
    allModels: ModelInfo[],
    opts: AnalyzeOptions
): PermissionRow[] {
    const rows: PermissionRow[] = [];

    let banco: 'sqlserver'|'postgres' = opts.defaultDb;
    let m: RegExpExecArray | null;
    const injectNames: string[] = [];
    while ((m = RX.injectConnNamed.exec(text))) injectNames.push(m[1]);

    if (opts.secondaryConnName && injectNames.includes(opts.secondaryConnName)) {
        banco = opts.defaultDb === 'sqlserver' ? 'postgres' : 'sqlserver';
    } else {
        const root = RX.sequelizeForRoot.exec(text);
        if (root) {
            const db = mapDialectToDb(root[1]);
            if (db) banco = db;
        }
    }

    for (const model of allModels) {
        const className = model.modelName;

        const variableNames = new Set<string>();
        const injectionRegex = new RegExp(`@InjectModel\\(\\s*${className}\\s*\\)\\s+(?:private|public|protected)?\\s*(?:readonly)?\\s+(\\w+)\\s*:`, "g");

        let match;
        while ((match = injectionRegex.exec(text)) !== null) {
            if (match[1]) variableNames.add(match[1]);
        }

        if (variableNames.size === 0) {
            const conventionalVarName = className.charAt(0).toLowerCase() + className.slice(1);
            variableNames.add(conventionalVarName);
        }

        const allVarNamesPattern = [...variableNames].join('|');
        const modelPattern = `\\b(this\\.(?:${allVarNamesPattern})|${className})\\b`;

        const findRegex = new RegExp(`${modelPattern}\\.(findAll|findOne|findAndCountAll|findAndCount|find)`, "g");
        const createRegex = new RegExp(`${modelPattern}\\.(create|save|insert|bulkCreate)`, "g");
        const updateRegex = new RegExp(`${modelPattern}\\.(update)`, "g");
        const deleteRegex = new RegExp(`${modelPattern}\\.(destroy|delete|remove|softDelete)`, "g");

        if (findRegex.test(text)) rows.push({ model: model.modelName, table: model.tableName ?? model.modelName, permission: 'SELECT', banco, origem: 'orm', file: fileName });
        if (createRegex.test(text)) rows.push({ model: model.modelName, table: model.tableName ?? model.modelName, permission: 'INSERT', banco, origem: 'orm', file: fileName });
        if (updateRegex.test(text)) rows.push({ model: model.modelName, table: model.tableName ?? model.modelName, permission: 'UPDATE', banco, origem: 'orm', file: fileName });
        if (deleteRegex.test(text)) rows.push({ model: model.modelName, table: model.tableName ?? model.modelName, permission: 'DELETE', banco, origem: 'orm', file: fileName });

        const includeRegex = new RegExp(`\\bmodel:\\s*${className}\\b`, "g");
        if (includeRegex.test(text)) {
            rows.push({ model: model.modelName, table: model.tableName ?? model.modelName, permission: 'SELECT', banco, origem: 'orm', file: fileName });
        }

        for (const rel of model.relations ?? []) {
            if (rel.joinTable) {
                rows.push({ model: model.modelName, table: rel.joinTable, permission: 'REFERENCES', banco, origem: 'relationship', file: fileName });
            }
        }
    }

    // --- LÓGICA SQL NATIVO REFINADA ---
    const sqlStringsRegex = /`([\s\S]+?)`/g;
    const commonNoise = new Set(['src', 'rxjs', 'node', 'mongoose', 'axios', '..', '.']);
    let sqlMatch;

    // 1. Itera apenas sobre o conteúdo dentro de `backticks`.
    while ((sqlMatch = sqlStringsRegex.exec(text)) !== null) {
        const sqlQueryText = sqlMatch[1];

        // 2. Encontra os CTEs apenas dentro da query atual.
        const cteNames = new Set<string>();
        const cteRegex = /(?:\bWITH|,)\s+([\w\d_]+)\s+AS\s*\(/gi;
        let cteMatch;
        while ((cteMatch = cteRegex.exec(sqlQueryText)) !== null) {
            cteNames.add(cleanTable(cteMatch[1]));
        }

        // 3. Encontra todas as tabelas em FROM/JOIN dentro da query.
        let tableMatch;
        while ((tableMatch = RX.sqlTables.exec(sqlQueryText)) !== null) {
            const table = cleanTable(tableMatch[1]);

            // 4. Adiciona a permissão somente se não for um CTE e não for "ruído".
            if (!cteNames.has(table) && !commonNoise.has(table.toLowerCase())) {
                let permission: PermissionRow['permission'] = 'SELECT'; // Default para queries complexas.
                if (/\bUPDATE\b/i.test(sqlQueryText)) permission = 'UPDATE';
                if (/\bINSERT\s+INTO\b/i.test(sqlQueryText)) permission = 'INSERT';
                if (/\bDELETE\s+FROM\b/i.test(sqlQueryText)) permission = 'DELETE';

                rows.push({ model: '-', table, permission, banco, origem: 'sql', file: fileName });
            }
        }
    }

    return rows;
}

function cleanTable(raw: string): string {
    return raw.replace(/^[\[\"]|[\]\"]$/g, "").trim();
}