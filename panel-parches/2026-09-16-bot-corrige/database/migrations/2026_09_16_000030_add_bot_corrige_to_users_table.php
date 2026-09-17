<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * [2026-09-16] Usuarios del panel autorizados a CORREGIR EL BOT por WhatsApp.
 *
 * El bot (bot-lajulita) lee la tabla `users` para saber quién puede mandarle "corrige <falla>"
 * (abre un ticket) o "/aprende <regla>" (le enseña algo). Se decide acá, en la pantalla de
 * usuarios, con dos datos nuevos: el celular de la persona y la marca `bot_puede_corregir`.
 * Un usuario inhabilitado (`activo` = false) pierde el permiso solo.
 *
 * `celular_clave` son los últimos 10 dígitos del celular, calculados por la base (columna
 * generada de Postgres): es lo que el bot compara con el remitente, sin importar si se cargó
 * con +57 o sin. Es única, así dos usuarios no pueden compartir número.
 *
 * Equivale a sql/users-bot-corrige.sql del repo del bot: correr UNA de las dos, no ambas
 * (las dos son idempotentes, pero no tiene sentido).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            if (! Schema::hasColumn('users', 'celular')) {
                $table->string('celular', 30)->nullable()->after('email');
            }
            if (! Schema::hasColumn('users', 'bot_puede_corregir')) {
                $table->boolean('bot_puede_corregir')->default(false)->after('activo');
            }
        });

        // Columna generada: Laravel no la modela, va en SQL crudo (Postgres).
        if (! Schema::hasColumn('users', 'celular_clave')) {
            DB::statement("alter table users add column celular_clave text generated always as (nullif(right(regexp_replace(coalesce(celular, ''), '\\D', '', 'g'), 10), '')) stored");
        }
        DB::statement('create unique index if not exists users_celular_clave_uidx on users (celular_clave) where celular_clave is not null');
        DB::statement('create index if not exists users_bot_corrige_idx on users (bot_puede_corregir) where bot_puede_corregir');

        // El bot solo lee estas columnas — nunca email, password ni remember_token.
        DB::statement("do $$ begin
            if exists (select 1 from pg_roles where rolname = 'bot_lajulita') then
                grant select (id, name, activo, celular_clave, bot_puede_corregir) on public.users to bot_lajulita;
            end if;
        end $$");
    }

    public function down(): void
    {
        DB::statement('drop index if exists users_celular_clave_uidx');
        DB::statement('drop index if exists users_bot_corrige_idx');
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['celular_clave', 'bot_puede_corregir', 'celular']);
        });
    }
};
