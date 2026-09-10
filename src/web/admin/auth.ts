import type { Request, Response, NextFunction } from "express";

// Le agregamos a la sesión de express-session un campo propio (isAdmin) — así TypeScript
// sabe que existe cuando lo leemos/escribimos más abajo.
declare module "express-session" {
  interface SessionData {
    isAdmin?: boolean;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.isAdmin) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: "No autenticado" });
}

export function login(req: Request, res: Response): void {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    res
      .status(500)
      .json({ ok: false, error: "ADMIN_PASSWORD no está configurado en el servidor (revisa el .env)." });
    return;
  }

  if (password === expected) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "Contraseña incorrecta" });
  }
}

export function logout(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
}

export function sessionStatus(req: Request, res: Response): void {
  res.json({ ok: true, isAdmin: Boolean(req.session?.isAdmin) });
}
