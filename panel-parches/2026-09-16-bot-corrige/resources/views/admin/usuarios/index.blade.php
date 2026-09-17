@extends('layouts.admin')

@section('titulo', 'Usuarios')

@section('contenido')
<div class="card">
    <div class="card-header d-flex justify-content-between align-items-center">
        <h3 class="card-title">Usuarios del panel</h3>
        @if(auth()->user()->hasPermiso('usuarios.crear'))
        <button class="btn btn-primary btn-sm" data-toggle="modal" data-target="#modal-crear-usuario"><i class="fas fa-plus"></i> Nuevo usuario</button>
        @endif
    </div>
    <div class="card-body">
        <table class="table table-bordered table-striped tabla-datos">
            <thead><tr><th>#</th><th>Nombre</th><th>Correo</th><th>Celular</th><th>Rol</th><th>Estado</th><th>Bot</th><th style="width:90px">Acciones</th></tr></thead>
            <tbody>
            @foreach($usuarios as $usuario)
                <tr>
                    <td>{{ $usuario->id }}</td>
                    <td>{{ $usuario->name }}</td>
                    <td>{{ $usuario->email }}</td>
                    <td>{{ $usuario->celular ?: '—' }}</td>
                    <td>{{ $usuario->rol->nombre ?? '— sin rol —' }}</td>
                    <td>
                        @if($usuario->activo)
                            <span class="badge badge-success">Activo</span>
                        @else
                            <span class="badge badge-secondary">Inhabilitado</span>
                        @endif
                    </td>
                    <td>
                        @if($usuario->bot_puede_corregir && $usuario->activo && $usuario->celular)
                            <span class="badge badge-primary" title="Puede reportar fallas con «corrige» y enseñarle reglas con /aprende"><i class="fab fa-whatsapp"></i> Corrige</span>
                        @elseif($usuario->bot_puede_corregir)
                            <span class="badge badge-warning" title="Tiene la marca pero está inhabilitado o sin celular: el bot no lo reconoce">Sin efecto</span>
                        @else
                            <span class="text-muted">—</span>
                        @endif
                    </td>
                    <td>
                        @if(auth()->user()->hasPermiso('usuarios.editar'))
                        <button class="btn btn-xs btn-info" data-toggle="modal" data-target="#modal-editar-usuario-{{ $usuario->id }}"><i class="fas fa-pen"></i></button>
                        @endif
                        @if(auth()->user()->hasPermiso('usuarios.eliminar') && $usuario->id !== auth()->id())
                        <form action="{{ route('admin.usuarios.destroy', $usuario) }}" method="POST" class="d-inline" onsubmit="return confirm('¿Eliminar este usuario?');">
                            @csrf @method('DELETE')
                            <button class="btn btn-xs btn-danger"><i class="fas fa-trash"></i></button>
                        </form>
                        @endif
                    </td>
                </tr>
            @endforeach
            </tbody>
        </table>
    </div>
</div>

<div class="modal fade" id="modal-crear-usuario">
    <div class="modal-dialog">
        <form action="{{ route('admin.usuarios.store') }}" method="POST" class="modal-content">
            @csrf
            @include('admin.usuarios._campos', ['usuario' => null, 'roles' => $roles])
        </form>
    </div>
</div>
@foreach($usuarios as $usuario)
<div class="modal fade" id="modal-editar-usuario-{{ $usuario->id }}">
    <div class="modal-dialog">
        <form action="{{ route('admin.usuarios.update', $usuario) }}" method="POST" class="modal-content">
            @csrf @method('PUT')
            @include('admin.usuarios._campos', ['usuario' => $usuario, 'roles' => $roles])
        </form>
    </div>
</div>
@endforeach
@endsection
