export type ModelInfo = {
    modelName: string;         // ex: OrderModel, ClientEntity
    tableName?: string;        // ex: Pedidos, clientes
    dbHint?: 'sqlserver' | 'postgres';
    relations?: Array<{ via: string; target: string; joinTable?: string }>;
};

export type PermissionRow = {
    model: string;
    table: string;
    permission: 'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'REFERENCES';
    banco: 'sqlserver' | 'postgres';
    origem: string; // Será uma string combinada, ex: "orm, sql"
    file?: string;
};

export type AnalyzeOptions = {
    defaultDb: 'sqlserver'|'postgres';
    secondaryConnName?: string;
};

export function mergeRows(rows: PermissionRow[]): PermissionRow[] {
    const map = new Map<string, PermissionRow & { origens: Set<string> }>();
    // A chave agora usa toLowerCase() no nome da tabela para agrupar sem diferenciar maiúsculas/minúsculas.
    const key = (r: PermissionRow) => `${r.table.toLowerCase()}|${r.permission}|${r.banco}`;

    for (const currentRow of rows) {
        const k = key(currentRow);
        const existingRow = map.get(k);

        if (!existingRow) {
            map.set(k, { ...currentRow, origens: new Set([currentRow.origem]) });
        } else {
            existingRow.origens.add(currentRow.origem);
            if (existingRow.model === '-' && currentRow.model !== '-') {
                existingRow.model = currentRow.model;
            }
            // Mantém a primeira capitalização encontrada para o nome da tabela.
        }
    }

    const finalRows: PermissionRow[] = [];
    for (const mergedRow of map.values()) {
        finalRows.push({
            model: mergedRow.model,
            table: mergedRow.table,
            permission: mergedRow.permission,
            banco: mergedRow.banco,
            origem: [...mergedRow.origens].sort().join(', '),
            file: mergedRow.file
        });
    }

    return finalRows;
}