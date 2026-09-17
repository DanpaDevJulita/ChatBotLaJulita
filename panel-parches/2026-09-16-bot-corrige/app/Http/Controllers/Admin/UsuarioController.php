<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\Rol;
use App\Models\User;
use App\Support\RegistradorBitacora;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;

class UsuarioController extends Controller
{
    public function index()
    {
        $usuarios = User::with('rol')->orderBy('name')->get();
        $roles = Rol::orderBy('nombre')->get();

        return view('admin.usuarios.index', compact('usuarios', 'roles'));
    }

    public function store(Request $request)
    {
        $datos = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', Password::min(8)],
            'rol_id' => ['required', 'integer', 'exists:roles,id'],
            // [2026-09-16] Celular para que el bot lo reconozca por WhatsApp. Obligatorio si se
            // marca "puede corregir el bot": sin número la marca no sirve para nada.
            'celular' => ['nullable', 'string', 'max:30', 'regex:/^\+?[\d\s\-().]{7,}$/', 'required_if:bot_puede_corregir,1'],
        ], [
            'celular.regex' => 'El celular solo puede tener dígitos, espacios, guiones y el signo +.',
            'celular.required_if' => 'Para que pueda corregir el bot hace falta su celular.',
        ], ['name' => 'nombre', 'rol_id' => 'rol']);

        $datos['password'] = Hash::make($datos['password']);
        $datos['activo'] = $request->boolean('activo', true);
        $datos['bot_puede_corregir'] = $request->boolean('bot_puede_corregir', false);

        try {
            $usuario = User::create($datos);
        } catch (\Illuminate\Database\UniqueConstraintViolationException $e) {
            return back()->withInput()->with('error', 'Ese celular ya está registrado en otro usuario.');
        }
        RegistradorBitacora::registrar('usuarios', 'crear', "Creó el usuario «{$usuario->email}»", null, ['name' => $usuario->name, 'email' => $usuario->email, 'rol_id' => $usuario->rol_id, 'celular' => $usuario->celular, 'bot_puede_corregir' => $usuario->bot_puede_corregir]);

        return back()->with('ok', 'Usuario creado.');
    }

    public function update(Request $request, User $usuario)
    {
        $datos = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email,'.$usuario->id],
            'password' => ['nullable', Password::min(8)],
            'rol_id' => ['required', 'integer', 'exists:roles,id'],
            'celular' => ['nullable', 'string', 'max:30', 'regex:/^\+?[\d\s\-().]{7,}$/', 'required_if:bot_puede_corregir,1'],
        ], [
            'celular.regex' => 'El celular solo puede tener dígitos, espacios, guiones y el signo +.',
            'celular.required_if' => 'Para que pueda corregir el bot hace falta su celular.',
        ], ['name' => 'nombre', 'rol_id' => 'rol']);

        $anterior = ['name' => $usuario->name, 'email' => $usuario->email, 'rol_id' => $usuario->rol_id, 'activo' => $usuario->activo, 'celular' => $usuario->celular, 'bot_puede_corregir' => $usuario->bot_puede_corregir];

        if (! empty($datos['password'])) {
            $datos['password'] = Hash::make($datos['password']);
        } else {
            unset($datos['password']);
        }

        $datos['activo'] = $request->boolean('activo', true);
        $datos['bot_puede_corregir'] = $request->boolean('bot_puede_corregir', false);

        try {
            $usuario->update($datos);
        } catch (\Illuminate\Database\UniqueConstraintViolationException $e) {
            return back()->withInput()->with('error', 'Ese celular ya está registrado en otro usuario.');
        }
        RegistradorBitacora::registrar('usuarios', 'editar', "Editó el usuario «{$usuario->email}»", $anterior, ['name' => $usuario->name, 'email' => $usuario->email, 'rol_id' => $usuario->rol_id, 'activo' => $usuario->activo, 'celular' => $usuario->celular, 'bot_puede_corregir' => $usuario->bot_puede_corregir]);

        return back()->with('ok', 'Usuario actualizado.');
    }

    public function destroy(User $usuario)
    {
        if ($usuario->id === Auth::id()) {
            return back()->with('error', 'No puedes eliminar tu propio usuario.');
        }

        $email = $usuario->email;
        $usuario->delete();
        RegistradorBitacora::registrar('usuarios', 'eliminar', "Eliminó el usuario «{$email}»");

        return back()->with('ok', 'Usuario eliminado.');
    }
}
