import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

const RX = {
    // ... (regexes existentes)
    tableSequelizeTs: /@Table\s*\(\s*\{[^}]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/g,
    className: /export\s+class\s+(\w+)/g,
    entityTypeORM: /@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`]|\{\s*name\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\})\s*\)/g,
    prismaModelUse: /prisma\.(\w+)\.(findMany|findFirst|create|update|delete|upsert|aggregate|groupBy)/g,
    sequelizeCalls: /\.(findAll|findOne|findAndCountAll|create|update|destroy|bulkCreate)\s*\(/g,
    typeormRepoCalls: /\.(find|findOne|findAndCount|save|insert|update|delete|remove|softDelete)\s*\(/g,
    sqlSelect: /\bSELECT\b[\s\S]+?\bFROM\b\s+([a-zA-Z0-9_"[\].]+)/gi,
    sqlInsert: /\bINSERT\s+INTO\b\s+([a-zA-Z0-9_"[\].]+)/gi,
    sqlUpdate: /\bUPDATE\b\s+([a-zA-Z0-9_"[\].]+)/gi,
    sqlDelete: /\bDELETE\s+FROM\b\s+([a-zA-Z0-9_"[\].]+)/gi,
    injectConnNamed: /@InjectConnection\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    sequelizeForRoot: /SequelizeModule\.forRoot\(\s*\{[\s\S]*?dialect\s*:\s*['"`](postgres|mssql)['"`][\s\S]*?\}\s*\)/g
};

function mapDialectToDb(dialect?: string): 'postgres'|'sqlserver'|undefined {
    if (!dialect) return;
    if (dialect.toLowerCase().includes('postgres')) return 'postgres';
    if (dialect.toLowerCase().includes('mssql') || dialect.toLowerCase().includes('sqlserver')) return 'sqlserver';
}

export function analyzeNodeModels(text: string, fileName: string): ModelInfo[] {
    // ... (função sem alterações)
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

    // Lógica de detecção do banco
    let banco: 'sqlserver'|'postgres' = opts.defaultDb;
    let m: RegExpExecArray | null;
    const injectNames: string[] = [];
    while ((m = RX.injectConnNamed.exec(text))) injectNames.push(m[1]);

    // Se o arquivo usa uma conexão nomeada que bate com a conexão SECUNDÁRIA...
    if (opts.secondaryConnName && injectNames.includes(opts.secondaryConnName)) {
        // ...então o banco deste arquivo é o OPOSTO do default.
        banco = opts.defaultDb === 'sqlserver' ? 'postgres' : 'sqlserver';
    } else {
        // Senão, tenta a heurística do SequelizeModule.forRoot
        const root = RX.sequelizeForRoot.exec(text);
        if (root) {
            const db = mapDialectToDb(root[1]);
            if (db) banco = db;
        }
    }

    // O restante da análise continua...
    for (const model of allModels) {
        const nameGuess = model.modelName;
        const modelUsage = new RegExp(`\\b${nameGuess}\\b`, "g");
        if (!modelUsage.test(text)) continue;

        let match: RegExpExecArray | null;
        const opMatches = [...text.matchAll(RX.sequelizeCalls), ...text.matchAll(RX.typeormRepoCalls)];
        for (const op of opMatches) {
            const verb = op[1].toLowerCase();
            let perm: PermissionRow["permission"] | undefined;
            if (/(find|count)/.test(verb)) perm = 'SELECT';
            if (/create|save|insert|bulkcreate/.test(verb)) perm = 'INSERT';
            if (/update/.test(verb)) perm = 'UPDATE';
            if (/destroy|delete|remove|softdelete/.test(verb)) perm = 'DELETE';
            if (perm) {
                rows.push({
                    model: model.modelName,
                    table: model.tableName ?? model.modelName,
                    permission: perm,
                    banco,
                    origem: 'orm',
                    file: fileName
                });
            }
        }
        while ((match = RX.prismaModelUse.exec(text))) {
            // ... (código do prisma sem alterações)
        }
        for (const rel of model.relations ?? []) {
            if (rel.joinTable) {
                rows.push({
                    model: model.modelName,
                    table: rel.joinTable,
                    permission: 'REFERENCES',
                    banco,
                    origem: 'relationship',
                    file: fileName
                });
            }
        }
    }

    let sm: RegExpExecArray | null;
    while ((sm = RX.sqlSelect.exec(text))) {
        rows.push({ model: '-', table: cleanTable(sm[1]), permission: 'SELECT', banco, origem: 'sql', file: fileName });
    }
    while ((sm = RX.sqlInsert.exec(text))) {
        rows.push({ model: '-', table: cleanTable(sm[1]), permission: 'INSERT', banco, origem: 'sql', file: fileName });
    }
    while ((sm = RX.sqlUpdate.exec(text))) {
        rows.push({ model: '-', table: cleanTable(sm[1]), permission: 'UPDATE', banco, origem: 'sql', file: fileName });
    }
    while ((sm = RX.sqlDelete.exec(text))) {
        rows.push({ model: '-', table: cleanTable(sm[1]), permission: 'DELETE', banco, origem: 'sql', file: fileName });
    }

    return rows;
}

function cleanTable(raw: string): string {
    return raw.replace(/^[\[\"]|[\]\"]$/g, "").trim();
}