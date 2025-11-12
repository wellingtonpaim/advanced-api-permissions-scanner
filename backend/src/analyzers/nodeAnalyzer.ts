import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

const RX = {
    tableSequelizeTs: /@Table\s*\(\s*\{[^}]*?\btableName\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?\}\s*\)/g,
    schemaSequelizeTs: /schema\s*:\s*['"`]([^'"`]+)['"`]/,
    className: /export\s+class\s+(\w+)/g,
    injectConnNamed: /@InjectConnection\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
};

export function analyzeNodeModels(text: string, fileName: string): ModelInfo[] {
    const models: ModelInfo[] = [];
    let m: RegExpExecArray | null;

    while ((m = RX.tableSequelizeTs.exec(text))) {
        const tableAnnotation = m[0];
        const tableNameMatch = /tableName\s*:\s*['"`]([^'"`]+)['"`]/.exec(tableAnnotation);
        const schemaMatch = RX.schemaSequelizeTs.exec(tableAnnotation);
        const tableName = tableNameMatch ? tableNameMatch[1] : undefined;
        const schema = schemaMatch ? schemaMatch[1] : undefined;

        const rest = text.slice(m.index);
        const classMatch = /export\s+class\s+(\w+)/.exec(rest);

        if (tableName && classMatch && classMatch[1]) {
            models.push({ modelName: classMatch[1], tableName, schema, relations: [] });
        }
    }

    return models;
}

export function analyzeNodeServices(
    textContent: string,
    fileName: string,
    allModels: ModelInfo[],
    opts: AnalyzeOptions
): PermissionRow[] {
    const rows: PermissionRow[] = [];
    let banco: 'sqlserver' | 'postgres' = opts.defaultDb;

    const text = textContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

    let m: RegExpExecArray | null;
    const injectNames: string[] = [];
    while ((m = RX.injectConnNamed.exec(text))) injectNames.push(m[1]);

    if (opts.secondaryConnName && injectNames.includes(opts.secondaryConnName)) {
        banco = opts.defaultDb === 'sqlserver' ? 'postgres' : 'sqlserver';
    }

    // Mapeamento de models que são efetivamente injetados no service
    const injectedModels = new Map<string, { variableNames: Set<string>, banco: 'sqlserver' | 'postgres' }>();

    // --- ANÁLISE ORM ---
    for (const model of allModels) {
        const className = model.modelName;
        const injectModelRegex = new RegExp(`@InjectModel\\(\\s*${className}(?:,\\s*['"]([^'"]+)['"])?\\s*\\)`);
        const injectMatch = injectModelRegex.exec(text);

        let modelBanco = banco;
        if (injectMatch && injectMatch[1]) {
            const connName = injectMatch[1].toLowerCase();
            if (connName.includes('postgres')) modelBanco = 'postgres';
            else if (connName.includes('sqlserver')) modelBanco = 'sqlserver';
        }

        // Se o model é injetado, processa normalmente
        if (injectMatch) {
            const variableNames = new Set<string>();
            const injectionRegex = new RegExp(`@InjectModel\\(\\s*${className}[^)]*\\)\\s+(?:private|public|protected)?\\s*(?:readonly)?\\s+(\\w+)\\s*:`, "g");

            let match;
            while ((match = injectionRegex.exec(text)) !== null) {
                if (match[1]) variableNames.add(match[1]);
            }

            if (variableNames.size > 0) {
                injectedModels.set(className, { variableNames, banco: modelBanco });

                const allVarNamesPattern = [...variableNames].join('|');
                const modelPattern = `\\bthis\\.(${allVarNamesPattern})\\b`;

                // Análise das operações ORM para models injetados
                if (new RegExp(`${modelPattern}\\.(findAll|findOne|findAndCountAll|count)`).test(text)) {
                    rows.push({ model: model.modelName, table: model.tableName, schema: model.schema, permission: 'SELECT', banco: modelBanco, origem: 'orm', file: fileName });
                }
                if (new RegExp(`${modelPattern}\\.(create|bulkCreate)`).test(text)) {
                    rows.push({ model: model.modelName, table: model.tableName, schema: model.schema, permission: 'INSERT', banco: modelBanco, origem: 'orm', file: fileName });
                }
                if (new RegExp(`${modelPattern}\\.(update)`).test(text)) {
                    rows.push({ model: model.modelName, table: model.tableName, schema: model.schema, permission: 'UPDATE', banco: modelBanco, origem: 'orm', file: fileName });
                }
                if (new RegExp(`${modelPattern}\\.(destroy)`).test(text)) {
                    rows.push({ model: model.modelName, table: model.tableName, schema: model.schema, permission: 'DELETE', banco: modelBanco, origem: 'orm', file: fileName });
                }
            }
        }
    }

    // --- ANÁLISE DE INCLUDES (models referenciados em consultas ORM) ---
    // Verifica se há pelo menos uma operação ORM válida sendo executada
    const hasValidOrmOperation = injectedModels.size > 0;

    if (hasValidOrmOperation) {
        for (const model of allModels) {
            const className = model.modelName;

            // Só mapeia includes se o model não está injetado (para evitar duplicação)
            if (!injectedModels.has(className)) {
                // Verifica se o model é usado em includes de consultas ORM
                const includePattern = new RegExp(`\\bmodel:\\s*${className}\\b`);
                if (includePattern.test(text)) {
                    // Determina o banco baseado no contexto da consulta ou usa o padrão
                    let modelBanco = banco;

                    // Tenta detectar o banco pela connection do model injetado que está fazendo a consulta
                    for (const [injectedModelName, injectedInfo] of injectedModels) {
                        const injectedVarPattern = [...injectedInfo.variableNames].join('|');
                        const consultaComIncludePattern = new RegExp(`\\bthis\\.(${injectedVarPattern})\\.[^\\n]*?\\bmodel:\\s*${className}\\b`, 's');
                        if (consultaComIncludePattern.test(text)) {
                            modelBanco = injectedInfo.banco;
                            break;
                        }
                    }

                    rows.push({
                        model: model.modelName,
                        table: model.tableName,
                        schema: model.schema,
                        permission: 'SELECT',
                        banco: modelBanco,
                        origem: 'orm',
                        file: fileName
                    });
                }
            }
        }
    }

    // --- ANÁLISE DE SQL NATIVO ---
    const sequelizeQueryRegex = /this\.sequelize\.query\s*\(\s*`([\s\S]+?)`/g;
    let sqlMatch;
    while ((sqlMatch = sequelizeQueryRegex.exec(text)) !== null) {
        const query = sqlMatch[1];

        const insertRegex = /INSERT\s+INTO\s+([a-zA-Z0-9_."\[\]]+)/gi;
        const updateRegex = /UPDATE\s+([a-zA-Z0-9_."\[\]]+)/gi;
        const deleteRegex = /DELETE\s+FROM\s+([a-zA-Z0-9_."\[\]]+)/gi;
        const selectTablesRegex = /(?:FROM|JOIN)\s+([a-zA-Z0-9_."\[\]]+)/gi;

        let opMatch;
        while ((opMatch = insertRegex.exec(query)) !== null) {
            rows.push({ model: '-', table: cleanTable(opMatch[1]), permission: 'INSERT', banco, origem: 'sql', file: fileName });
        }
        while ((opMatch = updateRegex.exec(query)) !== null) {
            rows.push({ model: '-', table: cleanTable(opMatch[1]), permission: 'UPDATE', banco, origem: 'sql', file: fileName });
        }
        while ((opMatch = deleteRegex.exec(query)) !== null) {
            rows.push({ model: '-', table: cleanTable(opMatch[1]), permission: 'DELETE', banco, origem: 'sql', file: fileName });
        }
        while ((opMatch = selectTablesRegex.exec(query)) !== null) {
            rows.push({ model: '-', table: cleanTable(opMatch[1]), permission: 'SELECT', banco, origem: 'sql', file: fileName });
        }
    }

    return rows;
}

function cleanTable(raw: string): string {
    return raw.replace(/^[\[\"]|[\]\"]$/g, "").replace(/\(NOLOCK\)/i, "").trim();
}