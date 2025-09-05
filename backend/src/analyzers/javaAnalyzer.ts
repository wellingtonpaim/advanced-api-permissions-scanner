import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

const entityTableRegex = /@Table\s*\(\s*name\s*=\s*["']([^"']+)["']\s*\)[\s\S]*?public\s+class\s+(\w+)/g;
const relationshipRegex = /@(ManyToOne|OneToMany|ManyToMany|OneToOne)[\s\S]*?(?:private|public|protected)?\s+([\w\d<>]+)\s+\w+\s*;/g;
const joinTableRegex = /@JoinTable\s*\(\s*name\s*=\s*"([^"]+)"/;

function getGenericType(type: string): string {
    const genericMatch = /<(\w+)>/.exec(type);
    return genericMatch ? genericMatch[1] : type;
}

export function analyzeJavaModels(text: string): ModelInfo[] {
    const res: ModelInfo[] = [];
    let m: RegExpExecArray | null;

    while ((m = entityTableRegex.exec(text))) {
        const tableName = m[1];
        const modelName = m[2];
        const relations: ModelInfo['relations'] = [];

        const classBodyStart = text.indexOf(modelName);
        const classBodyEnd = text.indexOf('}', classBodyStart);
        const classBody = text.substring(classBodyStart, classBodyEnd);

        let relMatch;
        while ((relMatch = relationshipRegex.exec(classBody)) !== null) {
            const annotationText = relMatch[0];
            let joinTable: string | undefined;
            if (relMatch[1] === 'ManyToMany') {
                const joinTableMatch = joinTableRegex.exec(annotationText);
                if (joinTableMatch && joinTableMatch[1]) {
                    joinTable = joinTableMatch[1];
                }
            }
            relations.push({ via: relMatch[1], target: relMatch[2], joinTable });
        }

        if (tableName && modelName) {
            res.push({ modelName, tableName, relations });
        }
    }
    return res;
}

function addSelectWithRelations(model: ModelInfo, allModels: ModelInfo[], rows: PermissionRow[], banco: 'sqlserver' | 'postgres', file: string, origem: 'orm' | 'relationship') {
    rows.push({ model: model.modelName, table: model.tableName, permission: 'SELECT', banco, origem, file });
    model.relations?.forEach(rel => {
        const targetType = getGenericType(rel.target);
        const relatedModel = allModels.find(m => m.modelName === targetType);
        if (relatedModel) {
            rows.push({ model: relatedModel.modelName, table: relatedModel.tableName, permission: 'SELECT', banco, origem: 'relationship', file });
        }
    });
}


export function analyzeJavaServices(
    text: string,
    fileName: string,
    allModels: ModelInfo[],
    opts: AnalyzeOptions
): PermissionRow[] {
    const rows: PermissionRow[] = [];
    const banco = opts.defaultDb;

    pushSqlDerived(rows, text, banco, fileName);

    for (const model of allModels) {
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
            // CORREÇÃO: .save() e semelhantes agora geram INSERT e UPDATE
            if (new RegExp(`\\b${varName}\\.(save|saveAll|persist)\\b`).test(text)) {
                rows.push({ model: model.modelName, table: model.tableName, permission: 'INSERT', banco, origem: 'orm', file: fileName });
                rows.push({ model: model.modelName, table: model.tableName, permission: 'UPDATE', banco, origem: 'orm', file: fileName });
            }
            if (new RegExp(`\\b${varName}\\.(find|get|exists|count|read|query|search|stream)\\b`).test(text)) {
                addSelectWithRelations(model, allModels, rows, banco, fileName, 'orm');
            }
            if (new RegExp(`\\b${varName}\\.(delete|remove)\\b`).test(text)) {
                rows.push({ model: model.modelName, table: model.tableName, permission: 'DELETE', banco, origem: 'orm', file: fileName });
            }
        }
    }

    const repoInterfaceRegex = /public\s+interface\s+(\w+Repository)\s+extends\s+JpaRepository<(\w+)/g;
    let repoMatch;
    while ((repoMatch = repoInterfaceRegex.exec(text)) !== null) {
        const entityName = repoMatch[2];
        const modelInfo = allModels.find(m => m.modelName === entityName);
        if (!modelInfo) continue;

        const interfaceBodyStart = repoMatch.index;
        const interfaceBodyEnd = text.indexOf('}', interfaceBodyStart);
        const interfaceBody = text.substring(interfaceBodyStart, interfaceBodyEnd);

        const methodRegex = /((?:Optional<.+?>|List<.+?>|\w+)\s+(\w+)\(.*\);)/g;
        let methodMatch;
        while ((methodMatch = methodRegex.exec(interfaceBody)) !== null) {
            if (methodMatch[0].includes('@Query')) continue;

            const methodName = methodMatch[2];
            const selectPrefixes = ['find', 'get', 'read', 'query', 'search', 'count', 'exists', 'stream'];
            const deletePrefixes = ['delete', 'remove'];

            if (selectPrefixes.some(p => methodName.startsWith(p))) {
                addSelectWithRelations(modelInfo, allModels, rows, banco, fileName, 'orm');
            } else if (deletePrefixes.some(p => methodName.startsWith(p))) {
                rows.push({ model: modelInfo.modelName, table: modelInfo.tableName, permission: 'DELETE', banco, origem: 'orm', file: fileName });
            }
        }

        const modifyingRegex = /@Modifying[\s\S]*?@Query\([\s\S]*?value\s*=\s*["'`]([\s\S]+?)["'`][\s\S]*?\)/g;
        let modMatch;
        while((modMatch = modifyingRegex.exec(interfaceBody)) !== null) {
            const query = modMatch[1].replace(/"\s*\+\s*"/g, "");
            if (query.trim().toUpperCase().startsWith('UPDATE')) {
                const updateTableMatch = /UPDATE\s+([a-zA-Z0-9_."\[\]]+)/i.exec(query);
                if (updateTableMatch?.[1]) {
                    rows.push({ model: '-', table: clean(updateTableMatch[1]), permission: 'UPDATE', banco, origem: 'sql', file: fileName });
                }
            }
        }
    }

    for (const model of allModels) {
        model.relations?.forEach(rel => {
            if (rel.via === 'ManyToMany' && rel.joinTable) {
                rows.push({ model: model.modelName, table: rel.joinTable, permission: 'REFERENCES', banco, origem: 'relationship', file: fileName });
            }
        });
    }

    return rows;
}

function pushSqlDerived(rows: PermissionRow[], source: string, banco: any, fileName: string) {
    const cleanedSource = source.replace(/\r\n|\r|\n/g, " ").replace(/"\s*\+\s*"/g, "");
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