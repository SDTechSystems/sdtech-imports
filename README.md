# SD Tech Imports

App de ventas, inventario, clientes e importaciones de SD Tech Imports. Es una versión de [EasyDrink](https://github.com/SDTechSystems/EasyDrink) adaptada para mercancía comprada en dólares (Amazon) y traída de Estados Unidos y China.

## Qué cambia frente a EasyDrink

- **Compras en dólares.** Al registrar una compra escribes el precio por unidad en US$. La app propone el dólar del día (TRM oficial de la Superintendencia Financiera, vía `/api/rate`) y puedes cambiarla por la tasa a la que compraste los dólares en Morse. Guarda la tasa usada en cada compra y convierte todo a pesos.
- **Envío manual.** Cada compra tiene un campo de costo de envío en pesos (casillero, flete o mensajería). Se reparte entre las unidades para calcular el costo real.
- **En tránsito / recibido.** Las compras quedan "en tránsito" y no suman al inventario hasta que las marcas como recibidas; en ese momento se suman y se recalcula el costo promedio.
- **Pedidos en camino.** El inicio muestra las compras en tránsito (origen, días en camino, guía). Al abrir una puedes marcarla como recibida y disponible.
- **Envío al cliente.** Al cobrar una venta puedes escribir el envío según la distancia. Se suma al total del recibo, pero no cuenta como ganancia.
- **Recibos con QR verificable.** Cada venta recibe un código aleatorio. El QR del recibo (en pantalla y en la impresora térmica) abre `/verificar/<código>`, una página pública que confirma si el recibo es auténtico o fue anulado.
- **Clientes.** Nombre y teléfono son opcionales; se pide al menos un dato.

## Nube (Cloudflare)

Funciona igual que EasyDrink: `wrangler.jsonc` publica la app (`dist/`) y el Worker (`worker/index.ts`) con un espacio KV para las copias de seguridad. El Worker además expone:

| Ruta | Acceso | Uso |
| --- | --- | --- |
| `GET /api/rate` | pública | Dólar del día (TRM; respaldo open.er-api.com), guardado 6 horas en KV |
| `POST /api/receipts` | clave de la nube | Registra un recibo al vender para que su QR funcione de inmediato |
| `DELETE /api/receipts/<código>` | clave de la nube | Marca el recibo como anulado al borrar la venta |
| `GET /api/verify/<código>` | pública | Verifica un recibo; si no se registró, lo busca en la última copia |

Para que el QR funcione, conecta la copia en la nube en Ajustes con tu clave. En la app de Android escribe la dirección pública en Ajustes → Recibo.

## Local data and backups

Sales and inventory records are stored in IndexedDB on the current device. The optional cloud backup (Cloudflare) keeps copies of the database and serves receipt verification; there is no live multi-device sync, online billing or telemetry. Local staff accounts do not provide shared access across devices.

Export regular JSON backups from Settings and keep a copy outside the device. Clearing browser storage or losing the device can remove the local database. The web app needs an initial visit while online before its cached interface can work offline.

## Run from source

Use a current Node.js LTS release, such as Node.js 22.12 or later, and npm.

```sh
git clone <url-del-repositorio>
cd <carpeta>
npm ci
npm run dev
```

The development server uses `http://localhost:8080`.

```sh
npm test
npm run lint
npm run build
npm run preview
```

The build updates `version.json` and generates the web application in `dist/`.

## Android build

Android builds require Android Studio, the Android SDK and JDK 21. Configure `JAVA_HOME` for the local JDK, then run:

```sh
npm run cap:sync
npx cap open android
```

From the `android/` directory, use `./gradlew assembleDebug` on Linux or macOS, or `.\gradlew.bat assembleDebug` on Windows. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Distribution builds require release signing.

## Development and license

The application uses React, TypeScript, Vite and Dexie. Translations are in `src/i18n/locales/es/` and `src/i18n/locales/en/`; the database is defined in `src/lib/db.ts`. Monetary values use integer Colombian pesos.

SD Tech Imports is derived from EasyDrink, which is derived from [FreeKasir](https://github.com/jipraks/kasirgratisan) through the [KhanxLab fork](https://github.com/KhanxLab/kasirgratisan). It retains its upstream contributors and [MIT license](LICENSE). Third-party components retain their respective notices.
