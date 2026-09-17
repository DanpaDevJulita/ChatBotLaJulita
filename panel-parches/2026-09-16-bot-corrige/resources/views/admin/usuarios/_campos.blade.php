<div class="modal-header">
    <h5 class="modal-title">{{ $usuario ? 'Editar usuario' : 'Nuevo usuario' }}</h5>
    <button type="button" class="close" data-dismiss="modal">&times;</button>
</div>
<div class="modal-body">
    <div class="form-group">
        <label>Nombre</label>
        <input type="text" name="name" class="form-control" value="{{ $usuario->name ?? '' }}" required>
    </div>
    <div class="form-group">
        <label>Correo</label>
        <input type="email" name="email" class="form-control" value="{{ $usuario->email ?? '' }}" required>
    </div>
    <div class="form-group">
        <label>Celular (WhatsApp)</label>
        <input type="tel" name="celular" class="form-control" value="{{ old('celular', $usuario->celular ?? '') }}" placeholder="+57 300 123 4567" maxlength="30">
        <small class="form-text text-muted">Con él el bot reconoce a esta persona cuando le escribe por WhatsApp.</small>
    </div>
    <div class="form-group">
        <label>{{ $usuario ? 'Nueva contraseña (déjalo vacío para no cambiarla)' : 'Contraseña' }}</label>
        <input type="password" name="password" class="form-control" {{ $usuario ? '' : 'required' }} minlength="8">
    </div>
    <div class="form-group">
        <label>Rol</label>
        <select name="rol_id" class="form-control" required>
            <option value="">Selecciona un rol</option>
            @foreach($roles as $rol)
                <option value="{{ $rol->id }}" @selected($usuario && $usuario->rol_id == $rol->id)>{{ $rol->nombre }}</option>
            @endforeach
        </select>
    </div>
    <div class="form-check">
        <input type="checkbox" name="activo" value="1" class="form-check-input" id="activo-usuario-{{ $usuario->id ?? 'nuevo' }}" @checked($usuario ? $usuario->activo : true)>
        <label class="form-check-label" for="activo-usuario-{{ $usuario->id ?? 'nuevo' }}">Usuario activo (puede iniciar sesión)</label>
    </div>
    {{-- [2026-09-16] Permiso para darle órdenes al bot por WhatsApp desde el celular de arriba:
         "corrige <falla>" (texto o audio) abre un ticket; "/aprende <regla>" le enseña algo. --}}
    <div class="form-check mt-2">
        <input type="checkbox" name="bot_puede_corregir" value="1" class="form-check-input" id="bot-corrige-usuario-{{ $usuario->id ?? 'nuevo' }}" @checked(old('bot_puede_corregir', $usuario->bot_puede_corregir ?? false))>
        <label class="form-check-label" for="bot-corrige-usuario-{{ $usuario->id ?? 'nuevo' }}">Puede corregir el bot por WhatsApp <small class="text-muted">(reportar fallas con «corrige» y enseñarle reglas con /aprende; requiere celular)</small></label>
    </div>
</div>
<div class="modal-footer">
    <button type="button" class="btn btn-secondary" data-dismiss="modal">Cancelar</button>
    <button type="submit" class="btn btn-primary">Guardar</button>
</div>
