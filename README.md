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
- Traefik configurado com rede externa `YkaroNET` e certresolver `letsencrypt`
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

## 🚀 Deploy no Portainer (Docker Swarm / Standalone)

Este projeto está pronto para deploy no Portainer utilizando **GitHub Container Registry (GHCR)**.

### Passo 1: Pré-requisitos
Certifique-se de que a rede externa do Traefik (`YkaroNET`) existe no seu Docker host:
```bash
docker network create --driver overlay --attachable YkaroNET
```

### Passo 2: Adicionar a Stack no Portainer
1. No Portainer, vá em **Stacks** -> **Add stack**.
2. Escolha o método **Repository** (Git).
3. Preencha:
   - **Repository URL**: `https://github.com/OrakySec/sistema-grupos-ofertas.git`
   - **Compose path**: `docker-compose.prod.yml`
   - Ative **Authentication** e use seu usuário `OrakySec` e um GitHub PAT (Token de Acesso Pessoal).

### Passo 3: Variáveis de Ambiente no Portainer
Defina as seguintes variáveis de ambiente (Environment variables) no painel da stack:
- `POSTGRES_USER`: `ofertas`
- `POSTGRES_PASSWORD`: *(Uma senha forte de sua escolha)*
- `POSTGRES_DB`: `ofertas`
- `ADMIN_EMAIL`: `orakysec@gmail.com`
- `ADMIN_PASSWORD_HASH`: `$2a$12$aEIsclyLU5bMXT8vsYRABecSGadJDaHxoH/R1iNq.Y5od98WZ/TfC` *(Hash da senha `@Deligar89541300`)*
- `JWT_SECRET`: `a27c09103834e98d35fde7f0f9707aa57990b76b1b0932549ed61b8753c1cefe`

*(Não é necessário definir `DATABASE_URL` nem `REDIS_URL`, elas são autogeradas).*

### Passo 4: Permissões do GHCR (GitHub Container Registry)
As imagens de container são construídas automaticamente pelo GitHub Actions a cada push na branch `main`. Como o repositório é privado, os pacotes nascem privados.
Para que o Portainer consiga baixar as imagens, você tem duas opções:
- **Tornar as imagens públicas (Recomendado)**: Vá no seu perfil do GitHub -> **Packages** -> clique em cada pacote (`frontend`, `api`, `worker`, `telegram-listener`) -> **Package Settings** -> role até a **Danger Zone** -> **Change visibility** -> Mude para **Public**. (Isso é seguro, pois nenhum segredo ou senha está embutido nas imagens).
- **Adicionar o registro no Portainer**: Vá em **Registries** -> **Add Registry** -> **Custom Registry** -> URL: `ghcr.io`, Username: `OrakySec`, Password: Seu GitHub PAT.

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
