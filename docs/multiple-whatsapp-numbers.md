# Múltiplos números de WhatsApp

O projeto aceita até 20 números no total: o número principal já existente e
até 19 adicionais. Cada número adicional recebe:

- uma caixa API exclusiva no Chatwoot;
- um contêiner Baileys e uma sessão de WhatsApp isolados;
- fila, estado, auditoria e QR Code próprios;
- webhook exclusivo da caixa, sem replicar mensagens para os outros números;
- volume persistente e inclusão no backup criptografado.

O número principal opera somente em modo receptivo: recebe e registra as
mensagens no Chatwoot, mas o gateway bloqueia respostas humanas e automáticas
por esse número. Os adicionais operam em modo ativo. Mensagens de todas as
caixas permanecem disponíveis na visão **Todos** do Chatwoot, preservando qual
número recebeu ou enviou cada mensagem.

O painel lateral do Assistente possui a aba **Números**, com o total conectado,
desconectado, modo de cada sessão e horário da última verificação. O WhatsApp
não permite copiar uma mensagem de outro chip para o aplicativo do número
principal; a visualização central correta é o Chatwoot.

## Capacidade do servidor

O limite de 20 é arquitetural, não uma promessa de que 20 sessões caibam no
servidor atual. Chatwoot, PostgreSQL, Redis e cada sessão Baileys consomem RAM e
CPU. Em um VPS de 1 vCPU e 4 GB, adicione poucos números por vez e acompanhe:

```bash
docker stats --no-stream
free -h
```

Antes de manter muitos números simultaneamente ativos, aumente CPU e RAM. O
script avisa a partir do quarto gateway, mas não interrompe a operação.

## Atualizar o servidor

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
chmod +x scripts/*.sh deploy/*.sh
./scripts/whatsapp-instance.sh refresh
./scripts/repair-chatwoot-webhook.sh
```

Essa atualização mantém a sessão e o volume do número principal.

## Adicionar um número

Use um identificador curto, com letras minúsculas, números e hífen. O terceiro
argumento opcional é o e-mail do vendedor que poderá acessar a nova caixa:

```bash
./scripts/whatsapp-instance.sh add vendas2 "Vendas 2" vendedor@empresa.com.br
./scripts/whatsapp-instance.sh qr vendas2
```

Escaneie o QR Code no WhatsApp do novo aparelho. Administradores e o usuário
técnico do assistente recebem acesso à caixa. Quando um vendedor é informado,
somente ele é incluído além dos administradores; os demais vendedores não veem
essa caixa.

Não reutilize o mesmo identificador para números diferentes. As configurações
e os segredos locais ficam em `.whatsapp-instances/`, fora do Git e com
permissão restrita.

## Operação

```bash
# Listar números e caixas
./scripts/whatsapp-instance.sh list

# Ver todos os estados ou apenas um
./scripts/whatsapp-instance.sh status
./scripts/whatsapp-instance.sh status vendas2

# Exibir novamente o QR
./scripts/whatsapp-instance.sh qr vendas2

# Parar ou iniciar apenas um número adicional
./scripts/whatsapp-instance.sh stop vendas2
./scripts/whatsapp-instance.sh start vendas2

# Após uma atualização do código, recriar todos os gateways com a mesma versão
./scripts/whatsapp-instance.sh refresh
```

O identificador `principal` pode ser usado nos comandos `status` e `qr` para o
número original. Não há remoção automática: excluir uma sessão ou caixa é uma
operação destrutiva e deve ser feita com backup e confirmação explícita.

## Backup

`deploy/backup.sh` detecta o cadastro local e inclui o estado de todas as
sessões, além dos arquivos de configuração criptografados. Durante a cópia, os
gateways são pausados brevemente e ligados novamente. Sempre mantenha um
destino externo configurado e teste a restauração antes de ampliar a operação.

## Limitação da integração

Baileys não é a API oficial da Meta. Isolar sessões reduz falhas cruzadas, mas
não elimina o risco de desconexão ou bloqueio. Não use os números para disparos
em massa e respeite limites, consentimento e qualidade das conversas.
