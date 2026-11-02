# SuperAhorro

SuperAhorro guarda usuarios, supermercados, productos y precios en SQLite. La página de comparación obtiene el catálogo desde el servidor; no contiene una copia estática del catálogo.

## Iniciar en Windows

1. Instala Python 3 si todavía no está disponible.
2. Abre PowerShell en esta carpeta y ejecuta:

   ```powershell
   python app.py
   ```

3. Abre `http://127.0.0.1:8000` en el navegador.

La primera ejecución crea `superahorro.db` y una cuenta local de demostración:

- Correo: `demo@superahorro.cl`
- Contraseña: `AhorroDemo2026!`

La contraseña de demostración es solo para desarrollo local. Para inicializar una instalación con una contraseña propia, define `SUPERAHORRO_ADMIN_EMAIL` y `SUPERAHORRO_ADMIN_PASSWORD` antes de la primera ejecución. Las cuentas adicionales se crean desde PowerShell:

```powershell
python app.py --create-user persona@ejemplo.cl --name "Nombre de la persona"
```

El servidor solicita la contraseña sin mostrarla y exige al menos 12 caracteres. La base de datos y los hashes de contraseña se guardan localmente.

También puedes crear una cuenta desde **Regístrate** en la página de acceso. El formulario solicita nombre, dirección, comuna, teléfono, correo electrónico y una contraseña de al menos 12 caracteres. Al completar el registro, inicia sesión automáticamente. Las cuentas existentes pueden acceder desde el formulario **Iniciar sesión**.

Para cambiar la contraseña de una cuenta existente:

```powershell
python app.py --reset-password demo@superahorro.cl
```

El cambio cierra las sesiones activas de esa cuenta.

## Datos incluidos

La base inicializa 55 supermercados, 5 productos y 25 precios/estados de stock tomados del catálogo de demostración que ya tenía la aplicación. Las coordenadas, direcciones y precios de muestra no son una fuente oficial ni información comercial en tiempo real. Verifica y actualiza esos datos antes de usarlos para decisiones de compra. Los precios se expresan en pesos chilenos.

Las tablas son `users`, `supermarkets`, `products` y `prices`. `users` guarda el nombre, la dirección, la comuna, el teléfono y el correo; la contraseña se almacena como hash con salt. La tabla `prices` relaciona cada producto con un supermercado e incluye precio, disponibilidad y fecha de actualización.

Para comparar una lista, pulsa **Importar lista Excel** y elige un archivo `.xlsx` con columnas `Producto` y `Cantidad` (`Marca` es opcional). La aplicación muestra los productos reconocidos y los no encontrados, además de los totales aproximados por supermercado. Las tiendas con toda la lista disponible aparecen primero, ordenadas desde el total más bajo; si ninguna tiene la lista completa, se prioriza la mayor cobertura y se informa el subtotal parcial. Los productos no encontrados o sin precio/stock no se suman. Los precios y el stock reflejan el último registro cargado: no son cotizaciones ni inventario en tiempo real. No se muestran alertas de ofertas activas ni “poco stock” porque el catálogo no recibe esos datos.

**Informes e historial:** al iniciar la app se conserva un primer snapshot de los precios ya registrados; se añaden nuevos puntos cuando cambia el precio o la disponibilidad en la base. Por eso la tendencia, los avisos de mínimo/aumento y la variación por categoría solo aparecen cuando existen observaciones suficientes. La variación local usa tiendas en un radio aproximado de 5 km (no límites comunales oficiales). No se reconstruyen datos anteriores a esta versión.

Al seleccionar un producto para consultar precios se registra el producto y la ubicación aproximada (coordenadas redondeadas a dos decimales, cerca de 1 km) para estadísticas agregadas de búsqueda. El panel B2B muestra esas búsquedas de los últimos 30 días y promedios del catálogo actual; no representa el mercado completo. Los informes B2B se pueden exportar a Excel o PDF. Las bibliotecas de gráficos y exportación se cargan desde CDN.

El panel B2B está limitado a cuentas administradoras. La cuenta de demostración configurada con `SUPERAHORRO_ADMIN_EMAIL` recibe ese rol durante la inicialización. Para asignar o retirar el rol de otra cuenta:

```powershell
python app.py --grant-admin persona@ejemplo.cl
python app.py --revoke-admin persona@ejemplo.cl
```

En móvil, el botón flotante alterna entre lista y mapa; el tema claro/oscuro se puede cambiar desde la barra superior. El archivo `Lista de compra.xlsx` es un ejemplo y no se importa automáticamente al catálogo.

## Configuración opcional

- `SUPERAHORRO_DB`: ruta alternativa del archivo SQLite.
- `SUPERAHORRO_HOST` y `SUPERAHORRO_PORT`: interfaz y puerto del servidor.
- `SUPERAHORRO_COOKIE_SECURE=1`: agrega el atributo `Secure` a la cookie al servir la aplicación bajo HTTPS.

El servidor incluido está pensado para desarrollo local. Para exponerlo en Internet, usa HTTPS, cambia la contraseña de demostración y despliega detrás de un servidor de producción.

## Organización del sitio

El JavaScript propio se mantiene en `scripts/`: `login.js` controla el acceso y el registro, `superahorro.js` controla el mapa y el comparador, `advanced.js` añade informes, `tailwind-config.js` configura los estilos y `basemaps-config.js` contiene la clave de CARTO. Si la clave falta o la capa CARTO falla, el mapa intenta usar teselas de OpenStreetMap como alternativa. Las bibliotecas externas se cargan desde sus CDN.
"# superahorro" 
