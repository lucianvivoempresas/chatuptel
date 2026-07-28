# Volt Conect Chat

Infraestrutura do MVP de atendimento multiusuário da Volt Conect:

- Chatwoot Community Edition;
- PostgreSQL e Redis privados;
- WPPConnect por QR Code para um número;
- até cinco atendentes no mesmo painel;
- migração futura para a API oficial do WhatsApp sem trocar o painel.

> O WPPConnect não é uma integração oficial da Meta. O uso pode causar
> desconexões ou banimento do número. Comece com um número secundário, não faça
> disparos em massa e mantenha um plano de migração para a Cloud API.

## Endereço

O endereço real deve ser `https://chat.voltconect.com.br`. O caminho
`https://www.voltconect.com.br/chat` será um redirecionamento para esse
subdomínio.

Chatwoot não suporta de forma confiável a execução sob um subdiretório:
frontend, assets, WebSocket, anexos e callbacks usam rotas absolutas. Forçar
`/chat` com reescritas do Nginx tornaria futuras atualizações frágeis.

## Requisitos do servidor

- Ubuntu 22.04 ou 24.04;
- Docker Engine e Docker Compose v2;
- Nginx e Certbot;
- 4 vCPU, 8 GB de RAM e 50 GB de SSD recomendados;
- DNS `A` de `chat.voltconect.com.br` apontando para `129.121.44.132`.

## Primeira implantação

```bash
git clone URL_DO_REPOSITORIO voltconect-chat
cd voltconect-chat
cp .env.example .env
nano .env
chmod +x scripts/*.sh deploy/*.sh
docker compose config --quiet
docker compose build wppconnect
docker compose run --rm rails bundle exec rails db:chatwoot_prepare
docker compose up -d
```

Gere valores independentes para `SECRET_KEY_BASE`, `POSTGRES_PASSWORD`,
`REDIS_PASSWORD` e `WPP_SECRET_KEY`. Nunca envie o `.env` ao GitHub.

```bash
openssl rand -hex 64
openssl rand -base64 36
```

## Nginx e TLS

1. Crie o registro DNS `A` para `chat.voltconect.com.br`.
2. Copie `deploy/nginx/chat.voltconect.com.br.conf` para
   `/etc/nginx/sites-available/`.
3. Crie o link em `/etc/nginx/sites-enabled/`, valide e recarregue o Nginx.
4. Execute:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d chat.voltconect.com.br
```

Inclua o conteúdo de `deploy/nginx/www-chat-redirect.conf` no bloco HTTPS já
existente de `www.voltconect.com.br`.

## Configuração inicial do Chatwoot

1. Abra `https://chat.voltconect.com.br` e crie a primeira conta.
2. Crie uma caixa de entrada do tipo **API** chamada `WhatsApp Volt Conect`.
3. Em **Perfil**, copie o token de acesso da API.
4. Descubra o ID da conta na URL (`/app/accounts/ID/...`) e o ID da caixa.
5. Preencha no `.env`:

```dotenv
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
CHATWOOT_API_TOKEN=valor-secreto
```

6. Convide os cinco atendentes com usuários individuais e ative 2FA.

## Parear o WhatsApp

No servidor:

```bash
./scripts/wpp-start.sh
```

O retorno contém o QR Code em base64. Escaneie em **WhatsApp > Aparelhos
conectados**. O token exibido pelo script será usado uma única vez na
configuração do webhook.

No Chatwoot, crie um webhook com assinatura `message_created`. Use exatamente a
URL interna exibida por `./scripts/wpp-start.sh`, no formato:

```text
http://wppconnect:21465/api/voltconect:TOKEN/chatwoot
```

Nossa imagem aplica um patch mínimo ao WPPConnect 2.10.0 para exigir autenticação
nesse endpoint. O projeto original deixa a rota de Chatwoot sem o middleware de
token. O patch também garante que o nome da sessão, sem o token anexado, seja
usado para localizar o cliente conectado.

O WPPConnect recebe mensagens do WhatsApp e cria contatos/conversas na caixa
API. Respostas dos atendentes geram `message_created` e voltam ao número.
Notas privadas e eventos que não sejam mensagens de saída são ignorados.

## Limites de segurança

- As portas 3000 e 21465 estão vinculadas a `127.0.0.1`.
- PostgreSQL e Redis não publicam portas.
- O WPPConnect é acessível externamente somente via túnel SSH.
- Tokens e senhas ficam apenas no `.env` do servidor.
- Não exponha `/api-docs` ou o WPPConnect pelo Nginx.
- Faça backup diário e copie o arquivo para armazenamento externo criptografado.
- Restrinja SSH por chave, ative firewall e atualizações automáticas de segurança.
- Não compartilhe contas entre atendentes.

Exemplo de firewall:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"
sudo ufw enable
```

## Operação

```bash
docker compose ps
docker compose logs -f --tail=200
./scripts/wpp-status.sh
./deploy/backup.sh
```

Antes de atualizar:

1. faça backup;
2. confira as notas de versão;
3. altere as versões fixadas;
4. execute `make update`;
5. valide envio, recebimento, mídia e atribuição de conversa.

## Próximas etapas

- validar texto, imagem, PDF, áudio e mensagens citadas;
- configurar SMTP e recuperação de senha;
- configurar backup externo e monitoramento;
- criar limites de envio e alerta de desconexão;
- documentar o procedimento de migração para a WhatsApp Cloud API;
- integrar contatos e oportunidades ao CRM.

## Licenças

Este repositório contém apenas configuração e código próprio de implantação.
Ele utiliza imagens/artefatos externos:

- Chatwoot Community Edition, conforme a licença do projeto e sem copiar a
  pasta Enterprise;
- WPPConnect Server, Apache-2.0.

Consulte e preserve os avisos de licença dos respectivos projetos.
