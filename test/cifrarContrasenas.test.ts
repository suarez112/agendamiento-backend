import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { cifrarContrasenasPendientes } from '../src/db/cifradoDeContrasenas.js';
import { verificarContrasena } from '../src/modules/auth/contrasenas.js';
import { type Contexto, iniciar, iniciarSesion } from './apoyo/servidor.js';

// db:cifrar-contrasenas — reemplaza por bcrypt las contraseñas en texto plano, sin tocar lo demás
describe('db:cifrar-contrasenas', () => {
  let ctx: Contexto;
  before(async () => {
    ctx = await iniciar();
  });
  after(() => ctx.cerrar());

  const hashDe = async (tabla: string, id: string) =>
    (await ctx.pool.query(`SELECT password_hash FROM ${tabla} WHERE id = $1`, [id])).rows[0].password_hash as string;

  test('cifra las de texto plano en barberos, usuarios y superadmins, y el inicio de sesión vuelve a funcionar', async () => {
    await ctx.pool.query("UPDATE barberos SET password_hash = 'texto-plano-1' WHERE id = 'barb_a'");
    await ctx.pool.query(
      "INSERT INTO usuarios (id, correo, usuario, password_hash, rol, nombre) VALUES ('u_plano', 'plano@correo.com', 'plano.user', 'texto-plano-2', 'cliente', 'Plano')",
    );
    await ctx.pool.query(
      "INSERT INTO superadmins (id, correo, password_hash, totp_secreto) VALUES ('s_plano', 'plano@plataforma.co', 'texto-plano-3', 'x.y.z')",
    );
    // Con texto plano nadie entra (desde M-3)
    assert.rejects(iniciarSesion(ctx, 'barbero.a', 'texto-plano-1'));

    const r = await cifrarContrasenasPendientes(ctx.pool);
    assert.deepEqual(r, { cifradas: 3, vacias: 0 });
    for (const [tabla, id, clave] of [['barberos', 'barb_a', 'texto-plano-1'], ['usuarios', 'u_plano', 'texto-plano-2'], ['superadmins', 's_plano', 'texto-plano-3']]) {
      const hash = await hashDe(tabla, id);
      assert.match(hash, /^\$2[aby]\$\d{2}\$/, tabla);
      assert.equal(await bcrypt.compare(clave, hash), true, `${tabla}: el hash es de la misma contraseña`);
      assert.equal((await verificarContrasena(clave, hash)).valida, true);
    }
    assert.ok(await iniciarSesion(ctx, 'barbero.a', 'texto-plano-1'), 'ahora sí entra con la misma contraseña');
  });

  test('no toca los hashes bcrypt ni los NULL, y repetirlo no cambia nada', async () => {
    const antes = await hashDe('barberos', 'admin_a');
    await ctx.pool.query("UPDATE barberos SET password_hash = NULL, usuario = NULL WHERE id = 'barb_a2'");
    const r = await cifrarContrasenasPendientes(ctx.pool);
    assert.deepEqual(r, { cifradas: 0, vacias: 0 });
    assert.equal(await hashDe('barberos', 'admin_a'), antes);
    assert.equal((await ctx.pool.query("SELECT password_hash FROM barberos WHERE id = 'barb_a2'")).rows[0].password_hash, null);
  });

  test('una contraseña vacía no se cifra (sería un hash válido de la contraseña vacía) y se avisa', async () => {
    await ctx.pool.query("UPDATE barberos SET password_hash = '' WHERE id = 'admin_b'");
    const r = await cifrarContrasenasPendientes(ctx.pool);
    assert.deepEqual(r, { cifradas: 0, vacias: 1 });
    assert.equal(await hashDe('barberos', 'admin_b'), '', 'sigue vacía');
  });

  test('no pisa un hash que se guarda mientras corre', async () => {
    await ctx.pool.query("UPDATE barberos SET password_hash = 'otra-plana' WHERE id = 'admin_a'");
    // Simula que alguien cambia la contraseña entre la lectura y la escritura: la condición del UPDATE lo evita
    const nuevo = await bcrypt.hash('clave-nueva-real', 4);
    const original = ctx.pool.query.bind(ctx.pool);
    let cambiado = false;
    (ctx.pool as unknown as { query: unknown }).query = async (texto: string, valores?: unknown[]) => {
      if (!cambiado && /^UPDATE barberos SET password_hash = \$2/.test(texto)) {
        cambiado = true;
        await original("UPDATE barberos SET password_hash = $1 WHERE id = 'admin_a'", [nuevo]);
      }
      return original(texto, valores);
    };
    try {
      await cifrarContrasenasPendientes(ctx.pool);
    } finally {
      (ctx.pool as unknown as { query: unknown }).query = original;
    }
    assert.equal(await hashDe('barberos', 'admin_a'), nuevo, 'se conserva la contraseña guardada en medio');
  });
});
