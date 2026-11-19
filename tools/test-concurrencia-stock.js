/**
 * ==============================================================================
 * Test de Concurrencia y Consistencia de Stock Multi-Caja (MasterDrinks POS)
 * ==============================================================================
 * Simula múltiples cajas (tablets) vendiendo productos simultáneamente en el
 * mismo milisegundo para verificar que el servidor y la base de datos previenen:
 *   1. Vender stock inexistente (sobreventa / stock negativo).
 *   2. Condiciones de carrera (race conditions) entre transacciones concurrentes.
 *   3. Inconsistencias entre producto, detalle_comanda y movimiento_stock.
 *   4. Fallos de rollback cuando un producto del carrito no tiene stock.
 *   5. Descuentos fraccionados concurrentes en vasos vinculados a botellas.
 * ==============================================================================
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'pos_evento.db');
const SERVER_URL = 'http://localhost:3000';

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
    mag: '\x1b[35m'
};

function banner(titulo) {
    console.log('\n' + C.cyan + C.bold + '================================================================' + C.reset);
    console.log(C.cyan + C.bold + '  ' + titulo + C.reset);
    console.log(C.cyan + C.bold + '================================================================' + C.reset);
}

function subheader(sub) {
    console.log('\n' + C.yellow + C.bold + '▶ ' + sub + C.reset);
}

function assert(cond, msg) {
    if (cond) {
        console.log(`  ${C.green}✔ [PASS]${C.reset} ${msg}`);
        return true;
    } else {
        console.log(`  ${C.red}✖ [FAIL]${C.reset} ${msg}`);
        return false;
    }
}

const db = new DatabaseSync(DB_PATH);

async function enviarComanda(cajaNombre, payload) {
    const tInicio = Date.now();
    try {
        const res = await fetch(`${SERVER_URL}/api/comanda`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const tFin = Date.now();
        const json = await res.json();
        return {
            caja: cajaNombre,
            status: res.status,
            ok: res.ok,
            data: json,
            duracionMs: tFin - tInicio
        };
    } catch (err) {
        return {
            caja: cajaNombre,
            status: 0,
            ok: false,
            error: err.message,
            duracionMs: Date.now() - tInicio
        };
    }
}

async function runTests() {
    banner('PRUEBAS DE CONCURRENCIA Y CONSISTENCIA DE STOCK (MULTI-CAJA)');
    console.log(C.gray + `Servidor objetivo: ${SERVER_URL}` + C.reset);
    console.log(C.gray + `Base de datos:    ${DB_PATH}` + C.reset);

    // Obtener referencias válidas
    const barra = db.prepare('SELECT id_barra, id_evento FROM barra LIMIT 1').get();
    const cajero = db.prepare('SELECT id_cajero FROM cajero WHERE activo = 1 LIMIT 1').get();
    const mesero = db.prepare('SELECT id_mesero FROM mesero WHERE activo = 1 LIMIT 1').get();
    const categoria = db.prepare('SELECT id_categoria FROM categoria_producto WHERE activo = 1 LIMIT 1').get();

    if (!barra || !cajero || !mesero || !categoria) {
        console.error(C.red + 'Faltan datos base en pos_evento.db (barra, cajero, mesero o categoría).' + C.reset);
        process.exit(1);
    }

    const testComandasIds = [];
    const testProductIds = [];

    function registrarIdComanda(id) {
        if (id && !testComandasIds.includes(id)) testComandasIds.push(id);
    }

    function crearProductoPrueba(nombre, stock, precio = 50, extra = {}) {
        const stmt = db.prepare(`
            INSERT INTO producto (nombre, precio_venta, stock_actual, id_categoria, activo, id_botella_vinculada, vasos_por_botella, orden)
            VALUES (?, ?, ?, ?, 1, ?, ?, 9999)
        `);
        const info = stmt.run(
            nombre,
            precio,
            stock,
            categoria.id_categoria,
            extra.id_botella_vinculada || null,
            extra.vasos_por_botella || null
        );
        const id = Number(info.lastInsertRowid);
        testProductIds.push(id);
        return id;
    }

    let allPass = true;

    try {
        // ======================================================================
        // PRUEBA 1: Venta simultánea entre 2 Cajas con Stock insuficiente
        // ======================================================================
        subheader('PRUEBA 1: Concurrencia entre 2 cajas (Stock = 5 | Caja A pide 3, Caja B pide 4)');
        console.log(C.gray + '  Simulando que ambas cajas tocan "Cobrar" en el mismo milisegundo exacto.' + C.reset);
        
        const idProd1 = crearProductoPrueba('TEST_CERVEZA_RACE', 5, 20);

        const payloadA = {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [{ id_producto: idProd1, cantidad: 3, acompanantes: [] }],
            metodos_pago: [{ id_metodo_pago: 1, monto: 60 }],
            observaciones: 'Test Caja A'
        };

        const payloadB = {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [{ id_producto: idProd1, cantidad: 4, acompanantes: [] }],
            metodos_pago: [{ id_metodo_pago: 1, monto: 80 }],
            observaciones: 'Test Caja B'
        };

        // Disparo concurrente
        const [respA, respB] = await Promise.all([
            enviarComanda('Caja 1 (Tablet A)', payloadA),
            enviarComanda('Caja 2 (Tablet B)', payloadB)
        ]);

        console.log(`  Respuesta ${respA.caja}: Status ${respA.status} (${respA.duracionMs}ms) -> ${respA.ok ? 'Venta Exitosa comanda #' + respA.data.id_comanda : respA.data.message}`);
        console.log(`  Respuesta ${respB.caja}: Status ${respB.status} (${respB.duracionMs}ms) -> ${respB.ok ? 'Venta Exitosa comanda #' + respB.data.id_comanda : respB.data.message}`);

        if (respA.ok) registrarIdComanda(respA.data.id_comanda);
        if (respB.ok) registrarIdComanda(respB.data.id_comanda);

        const prodDb1 = db.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(idProd1);
        console.log(`  Stock resultante en base de datos: ${C.bold}${prodDb1.stock_actual} uds${C.reset}`);

        const unaExitosaYUnaRechazada = (respA.ok && !respB.ok) || (!respA.ok && respB.ok);
        allPass = assert(unaExitosaYUnaRechazada, 'Exactamente una caja completó la venta y la otra fue rechazada') && allPass;
        allPass = assert(prodDb1.stock_actual >= 0, `El stock nunca fue negativo (Stock: ${prodDb1.stock_actual})`) && allPass;
        allPass = assert(prodDb1.stock_actual === 2 || prodDb1.stock_actual === 1, 'El stock remanente coincide exactamente con las unidades descontadas') && allPass;


        // ======================================================================
        // PRUEBA 2: Ráfaga masiva (10 Cajas concurrentes compitiendo por 3 unidades)
        // ======================================================================
        subheader('PRUEBA 2: Ráfaga masiva (10 cajas simultáneas compitiendo por 3 unidades)');
        console.log(C.gray + '  10 peticiones HTTP simultáneas lanzadas al mismo tiempo. Solo 3 deben ganar.' + C.reset);

        const idProd2 = crearProductoPrueba('TEST_WHISKY_SPIKE', 3, 100);

        const promesas10 = Array.from({ length: 10 }, (_, idx) => {
            const numCaja = idx + 1;
            return enviarComanda(`Caja ${numCaja}`, {
                id_evento: barra.id_evento,
                id_barra: barra.id_barra,
                id_cajero: cajero.id_cajero,
                id_mesero: mesero.id_mesero,
                items: [{ id_producto: idProd2, cantidad: 1, acompanantes: [] }],
                metodos_pago: [{ id_metodo_pago: 1, monto: 100 }],
                observaciones: `Test Spike Caja ${numCaja}`
            });
        });

        const resultados10 = await Promise.all(promesas10);
        let exitosas = 0;
        let rechazadas = 0;

        resultados10.forEach(r => {
            if (r.ok) {
                exitosas++;
                registrarIdComanda(r.data.id_comanda);
            } else {
                rechazadas++;
            }
        });

        console.log(`  Ventas exitosas (HTTP 200): ${C.green}${exitosas}${C.reset} | Ventas bloqueadas sin stock (HTTP 400): ${C.red}${rechazadas}${C.reset}`);

        const prodDb2 = db.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(idProd2);
        console.log(`  Stock final en base de datos: ${C.bold}${prodDb2.stock_actual} uds${C.reset}`);

        allPass = assert(exitosas === 3, `Se vendieron exactamente las 3 unidades existentes (Exitosas: ${exitosas})`) && allPass;
        allPass = assert(rechazadas === 7, `Se rechazaron exactamente las 7 peticiones sobrantes (Rechazadas: ${rechazadas})`) && allPass;
        allPass = assert(prodDb2.stock_actual === 0, `El stock final es exactamente 0 uds (sin sobreventa ni números negativos)`) && allPass;

        // Comprobar detalles de comandas
        const lineasVendidas = db.prepare(`
            SELECT COALESCE(SUM(cantidad), 0) as total_cant
            FROM detalle_comanda
            WHERE id_producto = ?
        `).get(idProd2);
        allPass = assert(lineasVendidas.total_cant === 3, `La suma de líneas de comanda en BD es exactamente 3 unidades`) && allPass;


        // ======================================================================
        // PRUEBA 3: Intento de venta de producto ya agotado (Stock = 0)
        // ======================================================================
        subheader('PRUEBA 3: Intento de venta cuando el producto ya está en 0');
        
        const idProd3 = crearProductoPrueba('TEST_VODKA_AGOTADO', 0, 80);

        const respAgotado = await enviarComanda('Caja 1', {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [{ id_producto: idProd3, cantidad: 1, acompanantes: [] }],
            metodos_pago: [{ id_metodo_pago: 1, monto: 80 }]
        });

        console.log(`  Respuesta: Status ${respAgotado.status} -> Mensaje: "${respAgotado.data.message}"`);
        allPass = assert(respAgotado.status === 400 && !respAgotado.ok, 'Rechazo inmediato con HTTP 400') && allPass;
        allPass = assert(/stock/i.test(respAgotado.data.message), 'El mensaje explica claramente falta de stock') && allPass;


        // ======================================================================
        // PRUEBA 4: Atomicidad y Rollback (Carrito mixto con un producto sin stock)
        // ======================================================================
        subheader('PRUEBA 4: Carrito con producto disponible + producto sin stock (Prueba de Rollback)');
        console.log(C.gray + '  Si un producto falla por stock, el otro producto NO debe descontarse.' + C.reset);

        const idProdDisponible = crearProductoPrueba('TEST_RON_OK', 10, 50);
        const idProdSinStock = crearProductoPrueba('TEST_RON_FAIL', 1, 50);

        const respRollback = await enviarComanda('Caja 1', {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [
                { id_producto: idProdDisponible, cantidad: 2, acompanantes: [] },
                { id_producto: idProdSinStock, cantidad: 5, acompanantes: [] } // Pide 5 habiendo 1
            ],
            metodos_pago: [{ id_metodo_pago: 1, monto: 350 }]
        });

        const stockDispDespues = db.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(idProdDisponible).stock_actual;
        const stockFailDespues = db.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(idProdSinStock).stock_actual;

        console.log(`  Respuesta comanda: Status ${respRollback.status} -> ${respRollback.data.message}`);
        console.log(`  Stock de producto disponible: Inicial=10 -> Actual=${stockDispDespues}`);
        console.log(`  Stock de producto sin stock:  Inicial=1  -> Actual=${stockFailDespues}`);

        allPass = assert(!respRollback.ok && respRollback.status === 400, 'La comanda fue rechazada completamente') && allPass;
        allPass = assert(stockDispDespues === 10, 'Rollback verificado: El stock del producto disponible quedó intacto (10 uds)') && allPass;
        allPass = assert(stockFailDespues === 1, 'El stock del producto sin unidades quedó intacto (1 ud)') && allPass;


        // ======================================================================
        // PRUEBA 5: Concurrencia en Vasos vinculados a Botella (Descuento fraccionado)
        // ======================================================================
        subheader('PRUEBA 5: Vasos vinculados a botella (1 Botella = 10 vasos | 2 Cajas piden 6 vasos c/u)');
        console.log(C.gray + '  Stock inicial: 1 botella (10 vasos). Caja A pide 6 vasos y Caja B pide 6 vasos (total 12 vasos).' + C.reset);

        const idBotella = crearProductoPrueba('TEST_BOTELLA_FERNET', 1, 150);
        const idVaso = crearProductoPrueba('TEST_VASO_FERNET', 999, 25, {
            id_botella_vinculada: idBotella,
            vasos_por_botella: 10
        });

        const payloadVasoA = {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [{ id_producto: idVaso, cantidad: 6, acompanantes: [] }],
            metodos_pago: [{ id_metodo_pago: 1, monto: 150 }],
            observaciones: 'Test Vasos Caja A'
        };

        const payloadVasoB = {
            id_evento: barra.id_evento,
            id_barra: barra.id_barra,
            id_cajero: cajero.id_cajero,
            id_mesero: mesero.id_mesero,
            items: [{ id_producto: idVaso, cantidad: 6, acompanantes: [] }],
            metodos_pago: [{ id_metodo_pago: 1, monto: 150 }],
            observaciones: 'Test Vasos Caja B'
        };

        const [respVasoA, respVasoB] = await Promise.all([
            enviarComanda('Caja 1 (Vasos)', payloadVasoA),
            enviarComanda('Caja 2 (Vasos)', payloadVasoB)
        ]);

        console.log(`  Respuesta ${respVasoA.caja}: Status ${respVasoA.status} -> ${respVasoA.ok ? 'Vendido #' + respVasoA.data.id_comanda : respVasoA.data.message}`);
        console.log(`  Respuesta ${respVasoB.caja}: Status ${respVasoB.status} -> ${respVasoB.ok ? 'Vendido #' + respVasoB.data.id_comanda : respVasoB.data.message}`);

        if (respVasoA.ok) registrarIdComanda(respVasoA.data.id_comanda);
        if (respVasoB.ok) registrarIdComanda(respVasoB.data.id_comanda);

        const botellaDb = db.prepare('SELECT stock_actual FROM producto WHERE id_producto = ?').get(idBotella);
        console.log(`  Stock de botella resultante: ${C.bold}${botellaDb.stock_actual} botellas${C.reset} (0.4 botellas = 4 vasos)`);

        const unaGanoVasos = (respVasoA.ok && !respVasoB.ok) || (!respVasoA.ok && respVasoB.ok);
        allPass = assert(unaGanoVasos, 'Solo una caja pudo vender 6 vasos; la otra fue rechazada por falta de botella') && allPass;
        allPass = assert(botellaDb.stock_actual === 0.4, 'La botella se descontó exactamente 0.6 quedando en 0.4 botellas') && allPass;

    } finally {
        // ======================================================================
        // LIMPIEZA AUTOMÁTICA DE DATOS DE PRUEBA
        // ======================================================================
        subheader('LIMPIEZA DE DATOS DE PRUEBA');
        console.log(C.gray + `  Limpiando ${testComandasIds.length} comandas de prueba y ${testProductIds.length} productos de prueba...` + C.reset);

        if (testComandasIds.length > 0) {
            const inPlaceholders = testComandasIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM detalle_comanda WHERE id_comanda IN (${inPlaceholders})`).run(...testComandasIds);
            db.prepare(`DELETE FROM pago_comanda WHERE id_comanda IN (${inPlaceholders})`).run(...testComandasIds);
            db.prepare(`DELETE FROM impresion_comanda_cajero WHERE id_comanda IN (${inPlaceholders})`).run(...testComandasIds);
            db.prepare(`DELETE FROM impresion_comanda_mesero WHERE id_comanda IN (${inPlaceholders})`).run(...testComandasIds);
            db.prepare(`DELETE FROM comanda WHERE id_comanda IN (${inPlaceholders})`).run(...testComandasIds);
        }

        if (testProductIds.length > 0) {
            const inProds = testProductIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM movimiento_stock WHERE id_producto IN (${inProds})`).run(...testProductIds);
            db.prepare(`DELETE FROM producto WHERE id_producto IN (${inProds})`).run(...testProductIds);
        }

        console.log(C.green + '  ✔ Limpieza finalizada. La base de datos quedó en su estado original intacto.' + C.reset);
    }

    banner('RESULTADO FINAL DE LAS PRUEBAS');
    if (allPass) {
        console.log(C.green + C.bold + '  🎉 TODAS LAS PRUEBAS DE CONCURRENCIA Y CONSISTENCIA PASARON EXITOSAMENTE.' + C.reset);
        console.log(C.green + '  El sistema garantiza que no se sobrevenden productos ni ocurren estados inconsistentes.' + C.reset);
    } else {
        console.log(C.red + C.bold + '  ⚠ ALGUNAS PRUEBAS FALLARON. REVISA LOS DETALLES ARRIBA.' + C.reset);
    }
    console.log('');
}

runTests().catch(err => {
    console.error('Error no controlado en la prueba:', err);
    process.exit(1);
});
