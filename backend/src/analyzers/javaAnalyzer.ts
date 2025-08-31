import { AnalyzeOptions, ModelInfo, PermissionRow } from "../utils/ormDetectors";

const RX = {
  entity: /@Entity\s*(?:\(\s*(?:name\s*=\s*)?["']([^"']+)["']\s*\))?/g,
  table: /@Table\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']\s*\)/g,
  className: /public\s+class\s+(\w+)/g,
  repoCalls: /\.(findAll|findById|findOne|save|saveAll|delete|deleteAll|deleteById|update)\s*\(/g,
  // @Query("select ... from Tabela t ...")
  queryAnnotation: /@Query\s*\(\s*["'`](.+?)["'`]\s*\)/gs,
  sqlSelect: /\bselect\b[\s\S]+?\bfrom\b\s+([a-zA-Z0-9_."[\]]+)/gi,
  sqlInsert: /\binsert\s+into\b\s+([a-zA-Z0-9_."[\]]+)/gi,
  sqlUpdate: /\bupdate\b\s+([a-zA-Z0-9_."[\]]+)/gi,
  sqlDelete: /\bdelete\s+from\b\s+([a-zA-Z0-9_."[\]]+)/gi
};

export function analyzeJavaModels(text: string): ModelInfo[] {
  const res: ModelInfo[] = [];
  const classes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RX.className.exec(text))) classes.push(m[1]);

  // entity/table
  const tableNames: string[] = [];
  while ((m = RX.table.exec(text))) tableNames.push(m[1]);
  const entityNames: string[] = [];
  while ((m = RX.entity.exec(text))) entityNames.push(m[1]);

  // map naive: first class with first table/entity name
  for (let i = 0; i < classes.length; i++) {
    const modelName = classes[i];
    const tableName = tableNames[i] || entityNames[i];
    if (tableName) res.push({ modelName, tableName, relations: [] });
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
  const banco = opts.defaultDb; // se precisar, dá pra inferir por configs spring em outra etapa

  // repo calls simples
  const repoOps = [...text.matchAll(RX.repoCalls)];
  for (const op of repoOps) {
    const verb = op[1].toLowerCase();
    let perm: PermissionRow["permission"] | undefined;
    if (/find/.test(verb)) perm = 'SELECT';
    if (/save/.test(verb)) perm = 'INSERT';
    if (/update/.test(verb)) perm = 'UPDATE';
    if (/delete/.test(verb)) perm = 'DELETE';
    if (perm) {
      rows.push({ model: '-', table: '-', permission: perm, banco, origem: 'orm', file: fileName });
    }
  }

  // @Query JPQL/SQL
  let qm: RegExpExecArray | null;
  while ((qm = RX.queryAnnotation.exec(text))) {
    const sql = qm[1];
    pushSqlDerived(rows, sql, banco, fileName);
  }

  // SQL literais
  pushSqlDerived(rows, text, banco, fileName);

  return rows;
}

function pushSqlDerived(rows: PermissionRow[], source: string, banco: any, fileName: string) {
  let m: RegExpExecArray | null;
  const RXs = {
    select: /\bselect\b[\s\S]+?\bfrom\b\s+([a-zA-Z0-9_."[\]]+)/gi,
    insert: /\binsert\s+into\b\s+([a-zA-Z0-9_."[\]]+)/gi,
    update: /\bupdate\b\s+([a-zA-Z0-9_."[\]]+)/gi,
    del: /\bdelete\s+from\b\s+([a-zA-Z0-9_."[\]]+)/gi
  };
  while ((m = RXs.select.exec(source))) rows.push({ model:'-', table:clean(m[1]), permission:'SELECT', banco, origem:'sql', file:fileName });
  while ((m = RXs.insert.exec(source))) rows.push({ model:'-', table:clean(m[1]), permission:'INSERT', banco, origem:'sql', file:fileName });
  while ((m = RXs.update.exec(source))) rows.push({ model:'-', table:clean(m[1]), permission:'UPDATE', banco, origem:'sql', file:fileName });
  while ((m = RXs.del.exec(source))) rows.push({ model:'-', table:clean(m[1]), permission:'DELETE', banco, origem:'sql', file:fileName });
}
function clean(x:string){ return x.replace(/^[\["]|[\]"]$/g,'').trim(); }
