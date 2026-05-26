# Sistema Grupos de Ofertas

Sistema web para monitorar grupos do Telegram e replicar ofertas automaticamente para grupos do Telegram e WhatsApp.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React + Vite + TypeScript |
| Backend API | Node.js + Fastify + Prisma |
| Banco de dados | PostgreSQL 16 |
| Fila | BullMQ + Redis 7 |
| Telegram (leitura) | Python + Telethon |
| Telegram (envio) | Telegram Bot API |
| WhatsApp | Evolution API (externa) |
| Infra | Docker Compose + Traefik |

---

## Pré-requisitos

- Docker + Docker Compose instalado no servidor
- Traefik configurado com rede externa `traefik_public` e certresolver `letsencrypt`
- Evolution API rodando separadamente (opcional no início)

---

## Setup Inicial

### 1. Clone e configure o ambiente

```bash
git clone <seu-repo>
cd sistema-grupos-ofertas

cp .env.example .env
```

### 2. Edite o `.env`

```bash
nano .env
```

Preencha obrigatoriamente:
- `POSTGRES_PASSWORD` — senha forte para o banco
- `JWT_SECRET` — string aleatória longa (use: `openssl rand -hex 32`)
- `ADMIN_PASSWORD_HASH` — hash bcrypt da senha do painel (veja abaixo)

### 3. Gere o hash da senha admin

```bash
# Instale o bcryptjs CLI temporariamente ou use Node.js:
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('@Deligar89541300', 12).then(h => console.log(h));
"
```

Cole o resultado em `ADMIN_PASSWORD_HASH` no `.env`.

### 4. Suba os containers (dev)

```bash
docker compose up -d
```

### 5. Suba em produção (com Traefik)

```bash
docker compose -f docker-compose.prod.yml up -d
```

---

## Configuração Pós-Deploy

Acesse `https://ofertas.ykaromarques.com` e faça login.

### Ordem de configuração no painel:

1. **Settings → Telegram (Leitura)**
   - Preencha API ID e API Hash (obtidos em [my.telegram.org](https://my.telegram.org))
   - Preencha o número de telefone (+55...)
   - Clique em **Autenticar** → aguarde o código no Telegram
   - Digite o código e confirme

2. **Settings → Telegram Bot (Envio)**
   - Crie um bot em [@BotFather](https://t.me/BotFather)
   - Cole o token recebido
   - Clique em **Testar conexão**

3. **Grupos → Grupos Fonte**
   - Adicione os grupos Telegram que você monitora
   - Use o ID numérico do grupo (ex: `-1001234567890`)

4. **Grupos → Grupos Destino**
   - Adicione seus grupos Telegram (o bot deve ser admin neles)
   - Adicione seus grupos WhatsApp (precisa da Evolution API configurada)

5. **Settings → WhatsApp (Evolution API)**
   - Preencha URL, API Key e nome da instância
   - Teste a conexão

6. **Settings → Comportamento**
   - Defina o modo: **Automático** ou **Manual**

---

## Estrutura do Projeto

```
sistema-grupos-ofertas/
├── api/                    # Backend Fastify + Prisma
│   ├── src/
│   │   ├── routes/         # Rotas da API
│   │   ├── services/       # Telegram + WhatsApp services
│   │   ├── middleware/     # JWT auth
│   │   └── lib/            # Prisma, Redis, BullMQ
│   ├── prisma/
│   │   └── schema.prisma
│   ├── Dockerfile
│   └── Dockerfile.worker
├── frontend/               # React + Vite
│   ├── src/
│   │   ├── pages/          # Dashboard, Queue, History, Groups, Settings, Logs
│   │   ├── components/     # Layout, Modal, OfferCard, etc.
│   │   └── lib/            # API client, Auth context
│   ├── Dockerfile
│   └── nginx.conf
├── telegram-listener/      # Python + Telethon
│   ├── main.py
│   └── Dockerfile
├── docker-compose.yml      # Dev
└── docker-compose.prod.yml # Produção (Traefik)
```

---

## Variáveis de Ambiente

| Variável | Descrição | Obrigatório |
|----------|-----------|-------------|
| `POSTGRES_USER` | Usuário do banco | ✅ |
| `POSTGRES_PASSWORD` | Senha do banco | ✅ |
| `POSTGRES_DB` | Nome do banco | ✅ |
| `DATABASE_URL` | URL completa do banco | ✅ |
| `REDIS_URL` | URL do Redis | ✅ |
| `ADMIN_EMAIL` | Email de acesso ao painel | ✅ |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt da senha | ✅ |
| `JWT_SECRET` | Secret para tokens JWT | ✅ |
| `NODE_ENV` | `development` ou `production` | ✅ |

---

## Comandos Úteis

```bash
# Ver logs de todos os serviços
docker compose logs -f

# Ver logs de um serviço específico
docker compose logs -f api
docker compose logs -f telegram-listener

# Reiniciar um serviço
docker compose restart api

# Executar migration manualmente
docker compose exec api npx prisma migrate deploy

# Acessar o banco
docker compose exec postgres psql -U ofertas -d ofertas

# Parar tudo
docker compose down

# Parar e remover volumes (CUIDADO: apaga dados)
docker compose down -v
```

---

## Fluxo de Funcionamento

```
1. telegram-listener monitora grupos fonte configurados
   └─► Detecta nova mensagem → faz download da mídia
   └─► POST /offers/internal → cria oferta no banco

2. Se auto_approve = true:
   └─► Status APPROVED automaticamente
   └─► Job "send-offer" enfileirado

3. Se auto_approve = false:
   └─► Status PENDING
   └─► Aparece na fila do painel para aprovação manual

4. Worker processa "send-offer":
   └─► Envia para todos os grupos destino ativos
   └─► TELEGRAM: via Bot API
   └─► WHATSAPP: via Evolution API
   └─► Registra resultado em delivery_logs
```
