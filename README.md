# Volt Conect Chat

Atendimento multiusuário com:

- Chatwoot Community Edition;
- PostgreSQL e Redis privados;
- gateway próprio baseado em Baileys;
- conexão de um WhatsApp por QR Code;
- até cinco atendentes no mesmo painel;
- arquitetura preparada para migração futura à API oficial.

> Baileys não é uma integração oficial da Meta. A conta pode sofrer
> desconexões ou bloqueio. Não use disparos em massa e comece, se possível, com
> um número secundário.

## Endereço

O Chatwoot funciona em `https://chat.voltconect.com.br`. O caminho
`https://www.voltconect.com.br/chat` apenas redireciona para o subdomínio,
evitando problemas com assets, WebSocket, anexos e callbacks.

## Requisitos

- Ubuntu 22.04 ou 24.04;
- Docker Engine e Docker Compose v2;
- Nginx e Certbot;
- 4 vCPU, 8 GB de RAM e 50 GB de SSD recomendados;
- DNS `A` de `chat.voltconect.com.br` apontando para o servidor.

## Primeira implantação

```bash
git clone https://github.com/lucianvivoempresas/chatuptel.git voltconect-chat
cd voltconect-chat
cp .env.example .env
nano .env
chmod +x scripts/*.sh deploy/*.sh
docker compose config --quiet
docker compose build baileys
docker compose run --rm rails bundle exec rails db:chatwoot_prepare
docker compose up -d
```

Gere segredos independentes. Nunca envie o arquivo `.env` ao GitHub.

```bash
openssl rand -hex 64
openssl rand -hex 32
```

## Configuração do Chatwoot

1. Entre em `https://chat.voltconect.com.br`.
2. Copie o ID da conta na URL (`/app/accounts/ID/...`).
3. Preencha no `.env`:

```dotenv
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
CHATWOOT_API_TOKEN=valor-secreto
BAILEYS_ADMIN_TOKEN=outro-segredo-gerado-com-openssl
```

4. Execute o instalador. Ele cria ou reutiliza automaticamente uma caixa do tipo
   **API** chamada `WhatsApp Volt Conect`, adiciona os usuários da conta, gera
   um token válido e grava o ID correto no `.env`:

```bash
./deploy/migrate-to-baileys.sh
```

O cartão WhatsApp nativo do Chatwoot é exclusivo da API oficial da Meta. Ele
continuará desativado ao usar Baileys; a conexão aparecerá como a caixa API
`WhatsApp Volt Conect`.

## Conectar o WhatsApp

Execute no servidor:

```bash
./scripts/baileys-qr.sh
```

O QR Code aparecerá no terminal. No telefone, abra:

**WhatsApp → Aparelhos conectados → Conectar um aparelho**

Depois confira:

```bash
./scripts/baileys-status.sh
```

O resultado esperado contém `"status":"connected"`. A sessão fica persistida
no volume `baileys_data`, portanto o QR não é solicitado após reinicializações
normais.

## Migrar uma instalação que usava WPPConnect

Na instalação existente, o processo é automático:

```bash
cd /opt/voltconect-chat
git pull
./deploy/migrate-to-baileys.sh
```

O script gera o token, substitui o contêiner antigo, cria o webhook no Chatwoot
e mostra o QR Code. Ele não apaga o volume antigo do WPPConnect, permitindo
recuperação manual se necessário.

## Nginx e TLS

O Chatwoot é publicado localmente na porta `3100`, pois a porta `3000` já é
utilizada pelo CRM.

```bash
sudo cp deploy/nginx/chat.voltconect.com.br.conf \
  /etc/nginx/sites-available/chat.voltconect.com.br.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d chat.voltconect.com.br
```

Inclua `deploy/nginx/www-chat-redirect.conf` no bloco HTTPS existente de
`www.voltconect.com.br`.

## Segurança

- As portas `3100` e `3001` ficam vinculadas a `127.0.0.1`.
- PostgreSQL e Redis não publicam portas.
- O webhook e as rotas administrativas exigem `BAILEYS_ADMIN_TOKEN`.
- Tokens e senhas ficam somente no `.env` do servidor.
- A sessão do WhatsApp fica no volume Docker e não é exposta aos atendentes.
- Cada atendente deve possuir usuário individual e autenticação em dois fatores.
- Não exponha a porta `3001` pelo Nginx.

## Operação

```bash
docker compose ps
docker compose logs --tail=100 baileys
./scripts/baileys-status.sh
./scripts/baileys-qr.sh
./deploy/backup.sh
```

O gateway suporta texto, imagens, documentos, áudio e vídeo. Mensagens de
grupos e Status são ignoradas. Respostas privadas do Chatwoot também são
ignoradas.

## Licenças

O repositório contém configurações e código próprio de integração. Ele utiliza:

- Chatwoot Community Edition, conforme a licença do projeto;
- Baileys, conforme a licença do projeto WhiskeySockets/Baileys.

Preserve os avisos de licença dos respectivos projetos.
