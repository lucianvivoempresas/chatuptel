.PHONY: config prepare up down logs status qr whatsapp-status backup update

config:
	docker compose config --quiet

prepare:
	docker compose run --rm rails bundle exec rails db:chatwoot_prepare

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

status:
	docker compose ps

qr:
	./scripts/baileys-qr.sh

whatsapp-status:
	./scripts/baileys-status.sh

backup:
	./deploy/backup.sh

update:
	docker compose pull
	docker compose build --pull baileys
	docker compose run --rm rails bundle exec rails db:chatwoot_prepare
	docker compose up -d
