<?php

namespace App\Models;

// Illuminate\Foundation\Auth\User ya trae Authenticatable + los traits normales de un modelo
// de usuario de Laravel (Notifiable, etc.), sin necesitar el paquete completo de scaffolding.
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

/**
 * Usuario del PANEL de administración (vendedores/administradores). No tiene nada que ver con
 * la tabla `clientes` del bot (esos son los huéspedes que reservan) — son dos mundos distintos
 * que conviven en la misma base de datos.
 *
 * Cada usuario tiene UN rol (rol_id), y cada rol trae su lista de permisos. Ver app/Models/Rol.php
 * y app/Models/Permiso.php.
 */
class User extends Authenticatable
{
    use Notifiable;

    protected $table = 'users';

    protected $fillable = [
        'name',
        'email',
        'password',
        'rol_id',
        'activo',
        // [2026-09-16] Para que el bot reconozca a esta persona por WhatsApp (ver migración
        // 2026_09_16_000030). `celular_clave` NO va acá: la calcula la base sola.
        'celular',
        'bot_puede_corregir',
    ];

    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'activo' => 'boolean',
            'bot_puede_corregir' => 'boolean',
        ];
    }

    public function rol()
    {
        return $this->belongsTo(Rol::class, 'rol_id');
    }

    /**
     * ¿Este usuario tiene el permiso `$clave` (ej. "planes.editar")? Sin rol asignado = sin
     * permisos (mejor negar por defecto que dejar pasar por accidente).
     */
    public function hasPermiso(string $clave): bool
    {
        if (! $this->rol) {
            return false;
        }

        return $this->rol->permisos->contains('clave', $clave);
    }

    /**
     * Todas las claves de permiso de este usuario, para pintar el menú lateral sin repetir
     * consultas (usado en el layout de AdminLTE).
     */
    public function clavesDePermisos(): array
    {
        return $this->rol?->permisos->pluck('clave')->all() ?? [];
    }
}
