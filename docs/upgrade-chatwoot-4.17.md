# Atualização segura do Chatwoot para 4.17 Community

O projeto usa uma migração gradual para reduzir o risco do salto entre versões:

```text
4.9.2-ce -> 4.12.1-ce -> 4.16.2-ce -> 4.17.0-ce
```

O atualizador:

- impede duas atualizações simultâneas;
- verifica a configuração e o espaço livre;
- pausa o timer de backup durante a manutenção;
- cria e valida um backup criptografado completo;
- pausa Rails, Sidekiq e Baileys;
- executa `db:chatwoot_prepare` em cada versão intermediária;
- valida saúde, banco, contas e caixas em cada etapa;
- reativa e valida a conexão Baileys ao final;
- preserva PostgreSQL, Redis, mídias, sessão do WhatsApp, tokens, CRM e marca.

## Executar

Reserve uma janela de manutenção. Durante o procedimento, novas mensagens
continuam no WhatsApp, mas só entram no Chatwoot depois que o gateway voltar.

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
chmod +x deploy/upgrade-chatwoot-4.17.sh deploy/backup.sh scripts/*.sh
./deploy/upgrade-chatwoot-4.17.sh
```

Não interrompa o terminal durante as migrações. Ao final, abra o painel e faça
um teste completo de recebimento e envio com um número secundário.

## Conferência da opção Premium

Acesse `https://chat.voltconect.com.br/super_admin`, entre em **Settings** e
procure **Manage Plan**. A documentação oficial informa que esse botão abre o
portal de contratação. A atualização Community não ativa recursos pagos.

Se a opção não aparecer na imagem Community, a contratação deve ser iniciada
diretamente com o Chatwoot. Não troque para a imagem Enterprise sem adquirir e
receber uma licença válida.

## Recuperação

O script mostra o caminho do backup anterior à atualização. Não tente apenas
voltar a tag da imagem depois que as migrações forem aplicadas: o banco também
precisa ser restaurado para o mesmo ponto. Em caso de falha, preserve os logs e
o arquivo exibido e faça a recuperação controlada.

```bash
docker compose ps
docker compose logs --tail=200 rails sidekiq baileys
journalctl -u voltconnect-backup.service --since today --no-pager
```
