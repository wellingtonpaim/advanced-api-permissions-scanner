import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { bufferToString, normalizeNL, ext } from "./utils/fileParser";
import { analyzeNodeModels, analyzeNodeServices } from "./analyzers/nodeAnalyzer";
import { analyzeJavaModels, analyzeJavaServices } from "./analyzers/javaAnalyzer";
import { AnalyzeOptions, mergeRows, PermissionRow } from "./utils/ormDetectors";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "../../frontend")));

/**
 * POST /analyze
 * multipart/form-data:
 * - services[]: arquivos .ts/.js/.java/.sql (services/repos/controllers/queries)
 * - models[]:   arquivos .ts/.java (models/entities)
 * - defaultDb:  'sqlserver' | 'postgres'
 * - postgresConnName: nome da conexão SECUNDÁRIA (opcional)
 */
app.post("/analyze", upload.fields([{ name: "services" }, { name: "models" }]), async (req, res) => {
    try {
        const defaultDb = (req.body.defaultDb || "sqlserver") as 'sqlserver'|'postgres';
        // O campo se chama 'postgresConnName', mas agora representa a conexão secundária
        const secondaryConnName = req.body.postgresConnName || "";
        const opts: AnalyzeOptions = { defaultDb, secondaryConnName };

        const svcFiles = (req.files?.["services"] as Express.Multer.File[]) || [];
        const mdlFiles = (req.files?.["models"] as Express.Multer.File[]) || [];

        // Parse texts
        const services = svcFiles.map(f => ({ name: f.originalname, text: normalizeNL(bufferToString(f.buffer)) }));
        const models = mdlFiles.map(f => ({ name: f.originalname, text: normalizeNL(bufferToString(f.buffer)) }));

        // 1) construir o catálogo de models (Node + Java)
        const allModels: ReturnType<typeof analyzeNodeModels> = [];
        for (const mf of models) {
            const e = ext(mf.name);
            if (e === "ts" || e === "js") {
                allModels.push(...analyzeNodeModels(mf.text, mf.name));
            } else if (e === "java") {
                allModels.push(...analyzeJavaModels(mf.text));
            }
        }

        // 2) analisar services/repositories/controllers (Node + Java)
        const rows: PermissionRow[] = [];
        for (const sf of services) {
            const e = ext(sf.name);
            if (e === "ts" || e === "js") {
                rows.push(...analyzeNodeServices(sf.text, sf.name, allModels, opts));
            } else if (e === "java") {
                rows.push(...analyzeJavaServices(sf.text, sf.name, allModels, opts));
            } else if (e === "sql") {
                rows.push({ model: '-', table: '-', permission: 'SELECT', banco: opts.defaultDb, origem:'sql', file: sf.name });
            }
        }

        // 3) completar REFERENCES para relações TypeORM (@JoinTable) no arquivo de model (node)
        for (const mf of models) {
            const joinTables = [...mf.text.matchAll(/@JoinTable\s*\(\s*\{\s*name\s*:\s*['"`]([^'"`]+)['"`]/g)];
            for (const jt of joinTables) {
                rows.push({ model: '-', table: jt[1], permission: 'REFERENCES', banco: opts.defaultDb, origem:'relationship', file: mf.name });
            }
        }

        const finalRows = mergeRows(rows).filter(r => r.table && r.table !== '-');

        res.json({ models: allModels, results: finalRows });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e?.message || "Internal error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scanner backend v7 listening on http://localhost:${PORT}`));