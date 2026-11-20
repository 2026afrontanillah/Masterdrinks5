const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'pos_evento.db');
const db = new DatabaseSync(dbPath);

console.log('--- Iniciando limpieza de base de datos ---');

db.exec('BEGIN IMMEDIATE');
try {
  // 1. Resetear stock de todos los productos a 0
  const prodRes = db.prepare('UPDATE producto SET stock_actual = 0').run();
  console.log(`✓ Stock de productos reseteado a 0 (${prodRes.changes} productos actualizados).`);

  // 2. Borrar comandas, detalles y pagos
  const impCaj = db.prepare('DELETE FROM impresion_comanda_cajero').run();
  const impMes = db.prepare('DELETE FROM impresion_comanda_mesero').run();
  const pagos = db.prepare('DELETE FROM pago_comanda').run();
  const detCom = db.prepare('DELETE FROM detalle_comanda').run();
  const com = db.prepare('DELETE FROM comanda').run();
  console.log(`✓ Comandas y pagos eliminados: ${com.changes} comandas, ${detCom.changes} líneas, ${pagos.changes} pagos, ${impCaj.changes + impMes.changes} tickets.`);

  // 3. Borrar movimientos de stock y traspasos
  const mov = db.prepare('DELETE FROM movimiento_stock').run();
  const trDet = db.prepare('DELETE FROM traspaso_detalle').run();
  const tr = db.prepare('DELETE FROM traspaso').run();
  console.log(`✓ Movimientos de stock eliminados: ${mov.changes} movimientos, ${tr.changes} traspasos.`);

  // 4. Borrar logs de auditoría
  const aud = db.prepare('DELETE FROM auditoria_admin').run();
  console.log(`✓ Logs de auditoría eliminados: ${aud.changes} registros.`);

  // 5. Reiniciar auto-incrementos (sqlite_sequence)
  db.exec(`
    DELETE FROM sqlite_sequence WHERE name IN (
      'comanda',
      'detalle_comanda',
      'pago_comanda',
      'impresion_comanda_cajero',
      'impresion_comanda_mesero',
      'movimiento_stock',
      'traspaso',
      'traspaso_detalle',
      'auditoria_admin'
    )
  `);
  console.log('✓ Secuencias de auto-incremento reiniciadas.');

  db.exec('COMMIT');
  console.log('✓ Transacción completada con éxito.');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('✗ Error en la transacción:', err);
  process.exit(1);
}

// 6. Optimizar y compactar base de datos
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  console.log('✓ VACUUM y checkpoint WAL ejecutados correctamente.');
} catch (e) {
  console.warn('Nota en vacuum:', e.message);
}

// 7. Verificación de integridad y conteo final
const check = db.prepare('PRAGMA integrity_check').get();
console.log(`✓ Chequeo de integridad: ${check.integrity_check}`);

console.log('\n--- Estado final de las tablas ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tables) {
  if (t.name.startsWith('sqlite_')) continue;
  const count = db.prepare(`SELECT count(*) as c FROM "${t.name}"`).get().c;
  console.log(`  ${t.name.padEnd(26)} : ${count} registros`);
}

db.close();
console.log('\nLimpieza finalizada.');
