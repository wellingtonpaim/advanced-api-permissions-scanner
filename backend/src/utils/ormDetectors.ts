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
  origem: 'orm' | 'relationship' | 'sql' | 'service';
  file?: string;
};

export type AnalyzeOptions = {
  defaultDb: 'sqlserver'|'postgres';
  postgresConnName?: string; // ex: 'postgres_db'
  // opcional: futuro - mapear conexão por arquivo/module
};

export function mergeRows(rows: PermissionRow[]): PermissionRow[] {
  // deduplica por (table, permission, banco, origem)
  const key = (r: PermissionRow) => `${r.table}|${r.permission}|${r.banco}|${r.origem}`;
  const map = new Map<string, PermissionRow>();
  for (const r of rows) {
    const k = key(r);
    if (!map.has(k)) map.set(k, r);
  }
  return [...map.values()];
}

