# Imagen de producción del Bot La Julita.
#
# NO se compila TypeScript a dist/. El bot arranca con tsx directamente sobre src/, porque el
# registro de agentes (src/agentes/_registro.ts) descubre los bots leyendo archivos `agente.ts`
# del disco, y cada agente carga su prompt desde un `.md` hermano. Compilar rompería las dos
# cosas. Por eso tsx vive en dependencies y no en devDependencies.

# Node 24 NO es opcional: @supabase/supabase-js abre un RealtimeClient al crear el cliente y
# necesita WebSocket nativo, que existe recién desde Node 22. Con Node 20 el proceso ni siquiera
# arranca — revienta en src/core/db/supabase.ts con "native WebSocket not found". Además 24 es la
# versión con la que se desarrolla en local, así que no hay sorpresas entre una y otra.
FROM node:24-slim

WORKDIR /app

# NODE_ENV antes del install: así npm ya omite devDependencies por su cuenta.
ENV NODE_ENV=production

# Las dependencias en su propia capa: mientras no cambien package.json ni el lock, Docker
# reutiliza esta capa y el build tarda segundos en vez de minutos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# El código, incluidos los prompts .md que el registro de agentes lee en caliente.
COPY . .

# Coincide con internal_port y con PORT en fly.toml.
EXPOSE 8080

# Por defecto arranca el web. fly.toml define los dos procesos ([processes] web / worker) y
# sobrescribe esto según el grupo al que pertenezca cada máquina.
CMD ["npm", "run", "web"]
