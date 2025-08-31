-----

# ⚡ Advanced API Permissions Scanner v7

Uma ferramenta (frontend + backend) para **analisar código de APIs** Node.js (Nest, Sequelize, TypeORM, Prisma) e Java (Spring JPA/Hibernate) e **extrair as permissões de banco** necessárias (SELECT / INSERT / UPDATE / DELETE / REFERENCES).
O scanner faz parsing heurístico (regex-based) em services/repos/controllers e modelos/entities para mapear **model → tabela**, identificar operações ORM e SQL nativo/JPQL, inferir banco alvo (`sqlserver` ou `postgres`) e gerar um relatório filtrável que pode ser exportado em CSV.

-----

## ✅ Principais funcionalidades

- Upload via **Drag & Drop** de arquivos de *services/repositories/controllers* e *models/entities*.
- Suporte a arquivos: **`.ts`, `.js`, `.java`, `.sql`, `.prisma`**.
- Detecta chamadas comuns de ORMs:
    - **Sequelize (sequelize-typescript)** — `findAll`, `create`, `update`, `destroy`, `findAndCountAll`, `@Table({ tableName })`, relações (`@BelongsToMany`, `@HasMany`, etc.).
    - **TypeORM** — `@Entity('table')`, `repo.find/save/update/delete`, `@JoinTable()`.
    - **Prisma** — `prisma.<model>.<action>`.
    - **JPA/Hibernate (Java)** — `@Entity`, `@Table`, `@Query(...)` (JPQL/SQL).
    - **SQL nativo / JPQL** — varre literais SQL (`SELECT ... FROM`, `INSERT INTO`, `UPDATE`, `DELETE`).
- Inferência de banco via:
    - `@InjectConnection('name')` (ex.: `@InjectConnection('postgres_db')`).
    - `SequelizeModule.forRoot({ dialect: 'postgres' | 'mssql', name: '...' })`.
    - Configuração no frontend (Banco default e nome de conexão postgres).
- Gera resultados deduplicados com: **Model | Tabela | Permissão | Banco | Origem | Arquivo**.
- Filtros avançados no frontend (por banco / permissão / busca).
- Exporta relatório em **CSV**.
- Backend em **TypeScript (Express + Multer)** para processamento robusto de arquivos.

-----

## 🗂 Estrutura do projeto (sugestão)

```
advanced-api-permissions-scanner/
├─ package.json
├─ README.md
├─ backend/
│  ├─ tsconfig.json
│  ├─ src/
│  │  ├─ analyzers/      # nodeAnalyzer.ts, javaAnalyzer.ts
│  │  ├─ utils/          # fileParser.ts, ormDetectors.ts
│  │  └─ server.ts
├─ frontend/
│  ├─ index.html
│  └─ script.js
```

> **Observação:** o repositório que você criar pode ter nomes/paths ligeiramente diferentes — ajuste os `docker-compose`/Dockerfile conforme necessário.

-----

## 🔧 Pré-requisitos

- Node.js (recomendado ≥ 18)
- npm
- Navegador moderno (Chrome/Edge/Firefox)
- Docker (opcional, para rodar via `docker-compose`)

-----

## 🛠️ Rodando localmente (modo dev)

### 1\. Backend (TypeScript)

```bash
cd backend
npm install
# rodar em modo desenvolvimento (ts-node-dev)
npm run dev
```

O serviço ficará disponível em: `http://localhost:3000`

**Endpoints:**
`POST /analyze` — aceita `multipart/form-data` (ver especificação abaixo).

### 2\. Frontend (HTML + JS)

Abra o arquivo `frontend/index.html` no seu navegador (duplo clique) ou sirva via HTTP (recomendado):

```bash
cd frontend
npx http-server . -p 8080    # ou qualquer server estático
```

Acesse `http://localhost:8080`.

## 📦 Rodando com Docker (docker-compose)

Crie um arquivo `docker-compose.yml` no nível do projeto com o conteúdo abaixo (exemplo):

```yaml
version: '3.8'
services:
  backend:
    build: ./backend
    container_name: api-permissions-backend
    ports:
      - "3000:3000"
    volumes:
      - ./backend:/usr/src/app
    command: npm run dev
  frontend:
    image: httpd:alpine
    container_name: api-permissions-frontend
    ports:
      - "8080:80"
    volumes:
      - ./frontend:/usr/local/apache2/htdocs/
```

**Dockerfile (backend)** — exemplo (em `backend/Dockerfile`):

```dockerfile
# imagem base
FROM node:18-alpine

WORKDIR /usr/src/app

# copiar package.json e instalar dependências
COPY package*.json ./
RUN npm ci --production=false

# copiar código
COPY . .

# compilar TS (opcional para produção)
RUN npm run build || true

EXPOSE 3000
# comando padrão (em dev o docker-compose pode sobrescrever por `npm run dev`)
CMD ["npm", "run", "dev"]
```

### Subir tudo

```bash
docker-compose up --build
```

- **Backend:** `http://localhost:3000`
- **Frontend:** `http://localhost:8080`

Se quiser ambiente produção, altere o `CMD` no Dockerfile para `["npm","run","start"]` (após `npm run build`) e ajuste o `docker-compose.yml` conforme seus requisitos.

-----

## 📡 API — endpoint principal

`POST /analyze`

**Content-Type:** `multipart/form-data`

**Campos:**

- `services` — arquivos de services/repositories/controllers (aceita múltiplos).
- `models` — arquivos de models/entities (aceita múltiplos).
- `defaultDb` — `'sqlserver'` ou `'postgres'` (string).
- `postgresConnName` — (opcional) nome usado em `@InjectConnection('...')` (ex.: `postgres_db`).

**Resposta (JSON)** — exemplo:

```json
{
  "models": [
    {"modelName":"OrderModel","tableName":"Pedidos","relations":[]}
  ],
  "results": [
    {
      "model": "OrderModel",
      "table": "Pedidos",
      "permission": "SELECT",
      "banco": "sqlserver",
      "origem": "orm",
      "file": "orderService.ts"
    }
  ]
}
```

**Exemplo `curl`:**

```bash
curl -X POST "http://localhost:3000/analyze" \
  -F "defaultDb=sqlserver" \
  -F "postgresConnName=postgres_db" \
  -F "services[]=@/caminho/para/service1.ts" \
  -F "services[]=@/caminho/para/service2.ts" \
  -F "models[]=@/caminho/para/orderModel.ts"
```

-----

## 🖥️ Uso do frontend (passo a passo)

1.  Abra a UI (`frontend/index.html` ou `http://localhost:8080` via Docker/http-server).
2.  **Aba Arquivos:** arraste seus arquivos de services/repos/controllers (pode acrescentar múltiplos).
3.  **Aba Models:** arraste os arquivos de Model/Entity (ajuda a mapear model → tabela).
4.  **Aba Configurações:**
    - Defina **Banco default** (`sqlserver` ou `postgres`).
    - Informe **Nome da conexão postgres** se sua aplicação usa `@InjectConnection('postgres_db')`.
5.  **Aba Resultados → clique em Analisar**. O frontend envia os arquivos para o backend e exibirá o relatório.
6.  Use os filtros por banco/permissão/busca e exporte para CSV se desejar.

-----

## 🔎 Limitações e dicas importantes

- O analisador do backend é **heurístico** (baseado em regex) — cobre os padrões mais comuns, mas pode deixar escapar casos muito dinâmicos (SQL construído por concatenação complexa, geração de query em runtime, strings muito fragmentadas).
- Se o scanner não encontrar certas tabelas que você espera:
    - Inclua os arquivos de **model (entities)** para melhorar a resolução model → table.
    - Envie exemplos reais de service + model (trechos) para que eu ajuste as heurísticas.
- Arquivos muito grandes ou um número muito grande de arquivos podem consumir memória durante a análise local. Em caso de problemas:
    - Faça upload em lotes menores; ou
    - Ajuste o limite de upload em `multer` (backend) e aumente recursos da máquina.
- Para ambientes com múltiplas conexões Sequelize, informe `postgresConnName` (ou mapeie manualmente em futuras melhorias).

-----

## 🛠️ Extensões sugeridas (possíveis implementações futuras)

- Suporte melhor a `@@map` / `@Column({ name })` e mapeamentos finos de coluna/tabela em Prisma / TypeORM / Sequelize.
- Parser baseado em AST (TypeScript/JavaParser) для maior precisão (menos falso-positivo/negativo).
- Integração com metadados reais do banco (conectar e validar existência de tabelas/constraints).
- Exportar em formatos XLSX/JSON/HTML.

-----

## 👷 Contribuição

Contribuições são bem-vindas. Recomendo abrir *issues* com exemplos mínimos de código que não estão sendo reconhecidos para que possamos melhorar as heurísticas.

-----

## 📝 Licença

[MIT](https://opensource.org/licenses/MIT)