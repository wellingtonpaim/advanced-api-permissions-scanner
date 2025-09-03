import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

// Regex para encontrar o nome da tabela e a classe da entidade associada
const entityTableRegex = /@Table\s*\(\s*name\s*=\s*["']([^"']+)["']\s*\)[\s\S]*?public\s+class\s+(\w+Entity)/g;

export function analyzeJavaModels(text: string): ModelInfo[] {
    const res: ModelInfo[] = [];
    let m: RegExpExecArray | null;

    // Usa uma regex mais robusta para associar a anotação @Table à classe que a sucede
    while ((m = entityTableRegex.exec(text))) {
        const tableName = m[1];
        const modelName = m[2]; // Entity Class Name (ex: PagadorEntity)
        if (tableName && modelName) {
            res.push({ modelName, tableName, relations: [] });
        }
    }
    return res;
}

export function analyzeJavaServices(
    text: string,
    fileName: string,
    allModels: ModelInfo[],
    opts: AnalyzeOptions
): PermissionRow[] {
    const rows: PermissionRow[] = [];
    const banco = opts.defaultDb;

    // --- 1. Análise de SQL Nativo (agora inclui JOINs e strings concatenadas) ---
    pushSqlDerived(rows, text, banco, fileName);

    // --- 2. Análise de Repositórios JPA ---
    for (const model of allModels) {
        // model.modelName é o nome da classe da entidade (ex: "PagadorEntity")
        // model.tableName é o nome da tabela (ex: "PAGADOR")

        const entityNameRoot = model.modelName.replace(/Entity$/, '');
        const repoClassName = `${entityNameRoot}Repository`;

        const variableNames = new Set<string>();
        const declarationRegex = new RegExp(`(?:@Autowired\\s+)?(?:private|public)?\\s*(?:final)?\\s*${repoClassName}\\s+(\\w+)`, "g");
        let declMatch;
        while ((declMatch = declarationRegex.exec(text))) {
            variableNames.add(declMatch[1]);
        }

        if (variableNames.size === 0) {
            variableNames.add(repoClassName.charAt(0).toLowerCase() + repoClassName.slice(1));
        }

        for (const varName of variableNames) {
            const saveRegex = new RegExp(`\\b${varName}\\.(save|saveAll)\\b`);
            const findRegex = new RegExp(`\\b${varName}\\.(find|get|exists)\\b`);
            const deleteRegex = new RegExp(`\\b${varName}\\.(delete|deleteAll)\\b`);

            if (saveRegex.test(text)) {
                // Corrigido: .save() e .saveAll() agora são mapeados apenas como INSERT.
                rows.push({ model: model.modelName, table: model.tableName, permission: 'INSERT', banco, origem: 'orm', file: fileName });
            }
            if (findRegex.test(text)) {
                rows.push({ model: model.modelName, table: model.tableName, permission: 'SELECT', banco, origem: 'orm', file: fileName });
            }
            if (deleteRegex.test(text)) {
                rows.push({ model: model.modelName, table: model.tableName, permission: 'DELETE', banco, origem: 'orm', file: fileName });
            }
        }
    }

    return rows;
}

function pushSqlDerived(rows: PermissionRow[], source: string, banco: any, fileName: string) {
    // Pré-processamento para juntar strings concatenadas com '+' e remover quebras de linha.
    const cleanedSource = source
        .replace(/\r\n|\r|\n/g, " ")
        .replace(/"\s*\+\s*"/g, "");

    let m: RegExpExecArray | null;
    const tablesInSelects = new Set<string>();

    const selectTableRegex = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_."\[\]]+)/gi;
    while ((m = selectTableRegex.exec(cleanedSource))) {
        tablesInSelects.add(clean(m[1]));
    }
    for (const table of tablesInSelects) {
        rows.push({ model:'-', table, permission:'SELECT', banco, origem:'sql', file:fileName });
    }

    const insertRegex = /\bINSERT\s+INTO\b\s+([a-zA-Z0-9_."\[\]]+)/gi;
    const updateRegex = /\bUPDATE\b\s+([a-zA-Z0-9_."\[\]]+)/gi;
    const deleteRegex = /\bDELETE\s+FROM\b\s+([a-zA-Z0-9_."\[\]]+)/gi;

    while ((m = insertRegex.exec(cleanedSource))) rows.push({ model:'-', table:clean(m[1]), permission:'INSERT', banco, origem:'sql', file:fileName });
    while ((m = updateRegex.exec(cleanedSource))) rows.push({ model:'-', table:clean(m[1]), permission:'UPDATE', banco, origem:'sql', file:fileName });
    while ((m = deleteRegex.exec(cleanedSource))) rows.push({ model:'-', table:clean(m[1]), permission:'DELETE', banco, origem:'sql', file:fileName });
}

function clean(x:string){ return x.replace(/\(nolock\)/gi, '').replace(/^[\["]|[\]"]$/g,'').trim(); }