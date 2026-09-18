#!/usr/bin/env bash
# Sube el .env local a Fly.io como secrets cifrados.
#
# Por qué un script y no pegar los valores a mano: el .env tiene el service_role_key de Supabase,
# la clave de YCloud y el token de LobbyPMS. Escribirlos en una terminal los deja en el historial
# del shell; pegarlos en el formulario web de Fly los guarda como variables normales, legibles en
# la configuración de la app. `fly secrets import` los lee de una tubería y los cifra.
#
#   bash scripts/subir-secretos-fly.sh [nombre-de-la-app]

set -euo pipefail

APP="${1:-botlajulita}"
ENV_FILE=".env"

# PORT y NODE_ENV NO se suben: ya están declarados en fly.toml. Si además fueran secrets, habría
# dos fuentes para el mismo valor y ganaría la menos evidente.
EXCLUIR="^(PORT|NODE_ENV)="

if [ ! -f "$ENV_FILE" ]; then
  echo "No encuentro $ENV_FILE en $(pwd)" >&2
  exit 1
fi

if ! command -v fly >/dev/null 2>&1 && ! command -v flyctl >/dev/null 2>&1; then
  echo "No tenés flyctl instalado. Instalalo desde https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi
FLY=$(command -v fly || command -v flyctl)

# Se descartan comentarios, líneas en blanco y variables SIN valor. Una variable vacía subida como
# secret es peor que ausente: el código que hace `?? valor_por_defecto` ve una cadena vacía, que
# no es null, y se queda con ella.
FILTRADAS=$(grep -E '^[A-Z_0-9]+=.+' "$ENV_FILE" | grep -vE "$EXCLUIR" || true)

if [ -z "$FILTRADAS" ]; then
  echo "No quedó ninguna variable para subir." >&2
  exit 1
fi

echo "App:        $APP"
echo "Variables:  $(printf '%s\n' "$FILTRADAS" | wc -l | tr -d ' ')"
echo ""
printf '%s\n' "$FILTRADAS" | cut -d= -f1 | sed 's/^/  · /'
echo ""
read -r -p "¿Subir estas variables como secrets de $APP? [s/N] " RESP
case "$RESP" in
  s|S|si|Si|SI|y|Y) ;;
  *) echo "Cancelado."; exit 0 ;;
esac

printf '%s\n' "$FILTRADAS" | "$FLY" secrets import --app "$APP"

echo ""
echo "Listo. Verificá con:  $FLY secrets list --app $APP"
echo "(muestra los nombres y un hash, nunca los valores)"
