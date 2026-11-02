// --- Database-backed catalog ---
const STORES = [];
const PRODUCTS = [];
const INVENTORY = {};

// --- App State ---
        let map;
        let userMarker;
        let storeMarkers = [];
        let currentUserLocation = { lat: -33.482, lng: -70.563 }; // Default: Peñalolén
        let selectedProduct = null;

        // --- Initialization ---
        document.addEventListener('DOMContentLoaded', async () => {
            setupProductListImport();
            try {
                const response = await fetch('/api/catalog', { credentials: 'same-origin' });
                if (response.status === 401) {
                    window.location.replace('/login.html');
                    return;
                }
                if (!response.ok) {
                    throw new Error('No se pudo cargar el catálogo desde la base de datos.');
                }
                const catalog = await response.json();
                STORES.push(...catalog.stores);
                PRODUCTS.push(...catalog.products);
                Object.assign(INVENTORY, catalog.inventory);
                document.getElementById('current-user').textContent = catalog.user.email;
                document.getElementById('logout-button').addEventListener('click', logout);
                setupEventListeners();
                renderPopularProducts();
                window.superAhorroIsAdmin = Boolean(catalog.user.is_admin);
                document.dispatchEvent(new Event('catalog-ready'));
                initMap();
                requestGeolocation({ silent: true });
            } catch (error) {
                document.getElementById('loading-skeleton').classList.add('hidden');
                document.getElementById('map-status').textContent = 'No se pudo cargar el catálogo';
                document.getElementById('search-message').textContent = error.message;
                document.getElementById('search-message').classList.remove('hidden');
            }
        });

        async function logout() {
            try {
                const response = await fetch('/api/logout', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                });
                if (!response.ok) {
                    throw new Error('No se pudo cerrar la sesión.');
                }
                window.location.replace('/login.html');
            } catch (error) {
                document.getElementById('search-message').textContent = error.message;
                document.getElementById('search-message').classList.remove('hidden');
            }
        }

        function initMap() {
            // Initialize Leaflet map
            map = L.map('map', {
                zoomControl: false // Add to custom position
            }).setView([currentUserLocation.lat, currentUserLocation.lng], 13);
            window.superAhorroMap = map;
            
            L.control.zoom({ position: 'bottomright' }).addTo(map);

            const basemapsApiKey = window.CARTO_BASEMAPS_API_KEY;
            if (basemapsApiKey) {
                const cartoLayer = L.tileLayer(
                    `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(basemapsApiKey)}`,
                    {
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                        subdomains: 'abcd',
                        maxZoom: 20
                    }
                );
                let usingFallback = false;
                cartoLayer.on('tileerror', () => {
                    if (usingFallback) return;
                    usingFallback = true;
                    map.removeLayer(cartoLayer);
                    addOpenStreetMapFallback();
                });
                cartoLayer.addTo(map);
            } else {
                addOpenStreetMapFallback();
            }

            updateUserMarker();
            showAllStoresOnMap();
        }

        function updateUserMarker() {
            if (userMarker) map.removeLayer(userMarker);
            
            const customIcon = L.divIcon({
                className: 'custom-user-marker',
                html: `<div class="pulse-marker"></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            });

            userMarker = L.marker([currentUserLocation.lat, currentUserLocation.lng], { icon: customIcon, zIndexOffset: 1000 }).addTo(map);
            userMarker.bindPopup("<b>Tu ubicación actual</b>").openPopup();
        }

        function addOpenStreetMapFallback() {
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(map);
        }

        // --- Utils: Distance Calculation ---
        function calculateDistance(lat1, lon1, lat2, lon2) {
            const R = 6371; // Earth's radius in km
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                      Math.sin(dLon/2) * Math.sin(dLon/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return (R * c).toFixed(1); // distance in km with 1 decimal
        }

        function formatCurrency(value) {
            return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(value);
        }

        // --- Geolocation ---
        function requestGeolocation(options = {}) {
            const { silent = false } = options;
            if (!silent) {
                document.getElementById('map-status').innerText = "Obteniendo ubicación...";
            }
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        const latitude = position.coords.latitude;
                        const longitude = position.coords.longitude;
                        if (!isValidLocation(latitude, longitude)) {
                            document.getElementById('map-status').innerText = "Ubicación no válida";
                            if (!silent) {
                                alert("No se pudo validar tu ubicación. Selecciona tu comuna manualmente.");
                            }
                            return;
                        }
                        currentUserLocation = { lat: latitude, lng: longitude };
                        
                        // Update dropdown to custom
                        const select = document.getElementById('commune-selector');
                        // add an option if it doesn't exist
                        let locationOption = [...select.options].find(option => option.text === "Ubicación Actual");
                        if (!locationOption) {
                            locationOption = new Option("Ubicación Actual", "");
                            select.add(locationOption, select[0]);
                        }
                        locationOption.value = `${currentUserLocation.lat},${currentUserLocation.lng}`;
                        select.value = locationOption.value;

                        if (map) {
                            updateUserMarker();
                            if (map.getSize().x > 0 && map.getSize().y > 0) {
                                map.flyTo([currentUserLocation.lat, currentUserLocation.lng], 18, {
                                    animate: true,
                                    duration: 1.2
                                });
                            }
                        }
                        document.getElementById('map-status').innerText = "Ubicación actualizada";
                        
                        // Recalculate distances if a product is selected
                        if(selectedProduct) {
                            renderComparisonList(selectedProduct);
                        }
                        
                        setTimeout(() => {
                            document.getElementById('map-status').innerText = "Viendo tiendas cercanas";
                        }, 3000);
                    },
                    () => {
                        if (!silent) {
                            alert("No se pudo obtener tu ubicación. Por favor selecciona tu comuna manualmente.");
                        }
                        document.getElementById('map-status').innerText = "Error de ubicación";
                    },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
                );
            } else {
                if (!silent) {
                    alert("Tu navegador no soporta geolocalización.");
                }
                document.getElementById('map-status').innerText = "Geolocalización no disponible";
            }
        }

        function updateLocationFromSelect(e) {
            const selectedLocation = e.target.value.trim();
            const coords = selectedLocation.split(',').map(Number);
            if (!selectedLocation || coords.length !== 2) {
                document.getElementById('map-status').innerText = "Selecciona una ubicación válida";
                return;
            }
            if (!isValidLocation(coords[0], coords[1])) {
                document.getElementById('map-status').innerText = "Selecciona una ubicación válida";
                return;
            }
            currentUserLocation = { lat: coords[0], lng: coords[1] };
            if (map) {
                updateUserMarker();
                if (map.getSize().x > 0 && map.getSize().y > 0) {
                    map.flyTo([currentUserLocation.lat, currentUserLocation.lng], 13);
                }
            }
            if(selectedProduct) {
                renderComparisonList(selectedProduct);
            }
        }

        function isValidLocation(latitude, longitude) {
            return Number.isFinite(latitude) && Number.isFinite(longitude)
                && latitude >= -90 && latitude <= 90
                && longitude >= -180 && longitude <= 180;
        }

        // --- Event Listeners ---
        function setupEventListeners() {
            const searchInput = document.getElementById('search-input');
            const select = document.getElementById('commune-selector');

            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.trim().toLowerCase();
                const message = document.getElementById('search-message');
                const initialState = document.getElementById('initial-state');
                const comparisonState = document.getElementById('comparison-state');

                if (query.length > 2) {
                    const match = PRODUCTS.find(p => p.name.toLowerCase().includes(query) || p.brand.toLowerCase().includes(query) || p.category.toLowerCase().includes(query));
                    if (match) {
                        message.classList.add('hidden');
                        selectProduct(match.id);
                    } else {
                        selectedProduct = null;
                        initialState.classList.add('hidden');
                        comparisonState.classList.add('hidden');
                        message.textContent = 'No encontramos ese producto. Prueba otra marca o categoría, o revisa los productos populares.';
                        message.classList.remove('hidden');
                        showAllStoresOnMap();
                    }
                } else if (query.length === 0) {
                    resetView();
                } else {
                    selectedProduct = null;
                    message.classList.add('hidden');
                    initialState.classList.remove('hidden');
                    comparisonState.classList.add('hidden');
                    showAllStoresOnMap();
                }
            });

            select.addEventListener('change', updateLocationFromSelect);
        }

        function setupProductListImport() {
            const listFileInput = document.getElementById('product-list-file');
            const listImportButton = document.getElementById('import-product-list');
            listImportButton.addEventListener('click', () => listFileInput.click());
            listFileInput.addEventListener('change', handleProductListUpload);
        }

        async function handleProductListUpload(event) {
            const fileInput = document.getElementById('product-list-file');
            const importButton = document.getElementById('import-product-list');
            const fileName = document.getElementById('product-list-file-name');
            const file = event.target.files[0];
            if (!file) return;

            const message = document.getElementById('list-upload-message');
            const results = document.getElementById('list-results');
            results.classList.add('hidden');
            results.innerHTML = '';
            fileName.textContent = file.name;
            message.className = 'mt-3 text-sm text-gray-600';
            message.textContent = 'Leyendo la lista...';
            importButton.disabled = true;

            try {
                if (!file.name.toLowerCase().endsWith('.xlsx')) {
                    throw new Error('Selecciona un archivo de Excel con formato .xlsx.');
                }
                if (!window.XLSX) {
                    throw new Error('No se pudo cargar el lector de Excel. Revisa tu conexión e inténtalo nuevamente.');
                }

                const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
                if (workbook.SheetNames.length === 0) {
                    throw new Error('El archivo de Excel no contiene hojas para leer.');
                }
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
                const headerIndex = rows.findIndex(row =>
                    row.some(cell => normalizeProductText(cell) === 'producto')
                );
                if (headerIndex === -1) {
                    throw new Error('El Excel debe tener una fila de encabezados con las columnas "Producto" y "Cantidad".');
                }

                const headers = rows[headerIndex].map(normalizeProductText);
                const productIndex = headers.indexOf('producto');
                const brandIndex = headers.indexOf('marca');
                const quantityIndex = headers.indexOf('cantidad');
                if (quantityIndex === -1) {
                    throw new Error('No se encontró la columna "Cantidad" en el Excel.');
                }

                const items = rows.slice(headerIndex + 1)
                    .map((row, index) => {
                        const productName = String(row[productIndex] ?? '').trim();
                        const brand = brandIndex === -1 ? '' : String(row[brandIndex] ?? '').trim();
                        if (!productName && !brand) return null;
                        const quantity = Number(row[quantityIndex]);
                        const itemLabel = brand || productName;
                        if (!Number.isFinite(quantity) || quantity <= 0) {
                            throw new Error(`La cantidad de "${itemLabel}" (fila ${headerIndex + index + 2}) debe ser un número mayor que cero.`);
                        }
                        return { productName, brand, quantity };
                    })
                    .filter(Boolean);

                if (items.length === 0) {
                    throw new Error('El Excel no contiene productos para buscar.');
                }

                renderProductListResults(items);
                message.className = 'mt-3 text-sm text-emerald-700';
                message.textContent = `Lista procesada: ${items.length} ${items.length === 1 ? 'producto' : 'productos'}.`;
            } catch (error) {
                message.className = 'mt-3 text-sm text-red-600';
                message.textContent = error.message;
            } finally {
                fileInput.value = '';
                importButton.disabled = false;
            }
        }

        function normalizeProductText(value) {
            return String(value ?? '').trim().toLocaleLowerCase('es')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }

        function renderProductListResults(items) {
            const results = document.getElementById('list-results');
            const matchedItems = [];
            const unmatchedItems = [];

            items.forEach(item => {
                const brandQuery = normalizeProductText(item.brand);
                const productQuery = normalizeProductText(item.productName);
                const query = brandQuery || productQuery;
                const searchField = brandQuery ? 'brand' : 'name';
                const match = PRODUCTS.find(product => normalizeProductText(product[searchField]) === query)
                    || PRODUCTS.find(product => {
                        const catalogValue = normalizeProductText(product[searchField]);
                        return catalogValue.includes(query) || query.includes(catalogValue);
                    });
                if (match) {
                        matchedItems.push({ product: match, quantity: item.quantity, item });
                } else {
                    unmatchedItems.push(item);
                }
            });

            const storeTotals = STORES.map(store => {
                let total = 0;
                let availableCount = 0;
                let priceCount = 0;
                const unavailable = [];
                const lineItems = [];

                matchedItems.forEach(({ product, quantity }) => {
                    const inventory = INVENTORY[`${store.id}_${product.id}`];
                    if (inventory) priceCount += 1;
                    if (inventory && inventory.stock) {
                        const subtotal = inventory.price * quantity;
                        total += subtotal;
                        availableCount += 1;
                        lineItems.push({ product, quantity, price: inventory.price, subtotal });
                    } else {
                        unavailable.push(product.name);
                    }
                });

                return { store, total, availableCount, priceCount, unavailable, lineItems };
            });

            const foundCount = matchedItems.length;
            const completeBaskets = storeTotals.filter(({ availableCount }) => availableCount === foundCount);
            const lowestTotal = completeBaskets.length > 0
                ? Math.min(...completeBaskets.map(({ total }) => total))
                : null;
            storeTotals.sort((a, b) => {
                const aHasCompleteBasket = a.availableCount === foundCount;
                const bHasCompleteBasket = b.availableCount === foundCount;
                if (aHasCompleteBasket !== bHasCompleteBasket) {
                    return aHasCompleteBasket ? -1 : 1;
                }
                if (!aHasCompleteBasket && a.availableCount !== b.availableCount) {
                    return b.availableCount - a.availableCount;
                }
                return a.total - b.total || a.store.id - b.store.id;
            });

            if (lowestTotal !== null) {
                const lowestStore = storeTotals.find(({ total, availableCount }) =>
                    availableCount === foundCount && total === lowestTotal
                );
                const lowestSummary = document.createElement('p');
                lowestSummary.className = 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800';
                lowestSummary.textContent = `Menor total aproximado: ${lowestStore.store.name} - ${formatCurrency(lowestTotal)} (lista completa).`;
                results.appendChild(lowestSummary);
            } else {
                const bestCoverage = storeTotals.find(({ availableCount }) => availableCount > 0);
                if (bestCoverage) {
                    const lowestSummary = document.createElement('p');
                    lowestSummary.className = 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800';
                    lowestSummary.textContent = `Ningún supermercado tiene la lista completa. Mayor cobertura: ${bestCoverage.store.name}, con ${bestCoverage.availableCount} de ${foundCount} productos y un subtotal aproximado de ${formatCurrency(bestCoverage.total)}.`;
                    results.appendChild(lowestSummary);
                }
            }

            const summary = document.createElement('p');
            summary.className = 'text-sm font-medium text-gray-700';
            summary.textContent = `Totales referenciales según los precios registrados. ${foundCount} de ${items.length} productos encontrados; los productos sin precio o stock y los no encontrados no se suman.`;
            results.appendChild(summary);

            const foundList = document.createElement('div');
            foundList.className = 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800';
            const foundTitle = document.createElement('h4');
            foundTitle.className = 'font-semibold';
            foundTitle.textContent = `Encontrados en el catálogo (${matchedItems.length})`;
            foundList.appendChild(foundTitle);
            if (matchedItems.length > 0) {
                const list = document.createElement('ul');
                list.className = 'mt-1 list-inside list-disc';
                matchedItems.forEach(({ product, quantity, item }) => {
                    const entry = document.createElement('li');
                    const importedName = item.brand
                        ? `${item.productName} (${item.brand})`
                        : item.productName;
                    entry.textContent = `${importedName} -> ${product.name} x${quantity}`;
                    list.appendChild(entry);
                });
                foundList.appendChild(list);
            } else {
                const empty = document.createElement('p');
                empty.className = 'mt-1';
                empty.textContent = 'No se encontraron productos de esta lista en el catálogo.';
                foundList.appendChild(empty);
            }
            results.appendChild(foundList);

            if (foundCount > 0) {
                const comparisonNote = document.createElement('p');
                comparisonNote.className = 'text-xs text-gray-500';
                comparisonNote.textContent = lowestTotal === null
                    ? 'Se muestran hasta los 3 supermercados con mayor disponibilidad y menor subtotal. Haz clic en un total para ver el detalle.'
                    : 'Se muestran hasta los 3 menores totales de listas completas. La estrella indica la opción más económica. Haz clic en un total para ver el detalle.';
                results.appendChild(comparisonNote);
            }

            if (unmatchedItems.length > 0) {
                const notFound = document.createElement('div');
                notFound.className = 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800';
                const title = document.createElement('h4');
                title.className = 'font-semibold';
                title.textContent = `No encontrados en el catálogo (${unmatchedItems.length})`;
                const list = document.createElement('ul');
                list.className = 'mt-1 list-inside list-disc';
                unmatchedItems.forEach(item => {
                    const entry = document.createElement('li');
                    entry.textContent = `${item.brand ? `${item.productName} (${item.brand})` : item.productName} x${item.quantity}`;
                    list.appendChild(entry);
                });
                notFound.append(title, list);
                results.appendChild(notFound);
            }

            if (foundCount === 0) {
                showAllStoresOnMap();
                results.classList.remove('hidden');
                return;
            }

            updateMapPinsForList(storeTotals, lowestTotal, foundCount);

            storeTotals.slice(0, 3).forEach(({ store, total, availableCount, priceCount, unavailable, lineItems }) => {
                const card = document.createElement('div');
                card.className = 'rounded-lg border border-gray-200 bg-white p-3';
                const title = document.createElement('h4');
                title.className = 'text-sm font-semibold text-gray-800';
                title.textContent = store.name;
                const isLowestTotal = lowestTotal !== null
                    && availableCount === foundCount
                    && total === lowestTotal;
                const totalDetails = document.createElement('details');
                totalDetails.className = 'group mt-1';
                const amount = document.createElement('summary');
                amount.className = 'flex cursor-pointer list-none items-center gap-2 text-lg font-bold text-primary';
                const totalLabel = availableCount > 0
                    ? formatCurrency(total)
                    : priceCount > 0 ? 'Sin productos disponibles' : 'Sin datos de precios';
                amount.setAttribute('aria-label', availableCount > 0
                    ? `Total ${formatCurrency(total)} en ${store.name}. Haz clic para ver el detalle.`
                    : `${totalLabel} en ${store.name}.`);
                if (isLowestTotal) {
                    const star = document.createElement('i');
                    star.className = 'fa-solid fa-star text-yellow-400';
                    star.setAttribute('aria-label', 'Menor total');
                    amount.appendChild(star);
                }
                amount.appendChild(document.createTextNode(totalLabel));
                const breakdown = document.createElement('div');
                breakdown.className = 'mt-2 space-y-2 border-t border-gray-100 pt-2';
                lineItems.forEach(({ product, quantity, price, subtotal }) => {
                    const line = document.createElement('div');
                    line.className = 'flex justify-between gap-3 text-xs text-gray-600';
                    const description = document.createElement('span');
                    description.textContent = `${product.name} x${quantity} (${formatCurrency(price)} c/u)`;
                    const lineTotal = document.createElement('span');
                    lineTotal.className = 'whitespace-nowrap font-medium';
                    lineTotal.textContent = formatCurrency(subtotal);
                    line.append(description, lineTotal);
                    breakdown.appendChild(line);
                });
                if (unavailable.length > 0) {
                    const missing = document.createElement('p');
                    missing.className = 'text-xs text-amber-700';
                    missing.textContent = `No incluidos por falta de precio o stock: ${unavailable.join(', ')}`;
                    breakdown.appendChild(missing);
                }
                totalDetails.append(amount, breakdown);
                const details = document.createElement('p');
                details.className = 'mt-1 text-xs text-gray-500';
                details.textContent = `Suma aproximada de ${availableCount} de ${foundCount} productos encontrados disponibles en esta tienda.`;
                card.append(title, totalDetails, details);

                if (unavailable.length > 0) {
                    const unavailableText = document.createElement('p');
                    unavailableText.className = 'mt-1 text-xs text-amber-700';
                    unavailableText.textContent = `Sin precio o sin stock: ${unavailable.join(', ')}`;
                    card.appendChild(unavailableText);
                }
                results.appendChild(card);
            });

            results.classList.remove('hidden');
        }

        // --- UI Rendering Logic ---
        function renderPopularProducts() {
            const container = document.getElementById('popular-products');
            container.innerHTML = '';
            
            PRODUCTS.forEach(product => {
                const card = document.createElement('div');
                card.className = "bg-white border border-gray-200 p-3 rounded-xl hover:border-primary hover:shadow-md transition cursor-pointer flex flex-col items-center text-center";
                card.onclick = () => {
                    document.getElementById('search-input').value = product.name;
                    selectProduct(product.id);
                };
                
                card.innerHTML = `
                    <img src="${product.img}" alt="${product.name}" class="w-16 h-16 object-contain mb-2 rounded-lg">
                    <span class="text-xs font-medium text-gray-500 line-clamp-1">${product.brand}</span>
                    <h4 class="text-sm font-semibold text-gray-800 leading-tight line-clamp-2">${product.name}</h4>
                `;
                container.appendChild(card);
            });
        }


        function selectProduct(productId) {
            selectedProduct = PRODUCTS.find(p => p.id === productId);
            if(!selectedProduct) return;

            // Toggle UI States
            document.getElementById('search-message').classList.add('hidden');
            document.getElementById('initial-state').classList.add('hidden');
            document.getElementById('comparison-state').classList.remove('hidden');

            // Render Header
            const header = document.getElementById('selected-product-header');
            header.innerHTML = `
                <img src="${selectedProduct.img}" alt="${selectedProduct.name}" class="w-16 h-16 object-contain rounded-lg bg-white border border-gray-200">
                <div>
                    <span class="text-xs font-bold text-primary uppercase tracking-wider">${selectedProduct.category} | ${selectedProduct.brand}</span>
                    <h2 class="text-lg font-bold text-gray-900 leading-tight">${selectedProduct.name}</h2>
                </div>
            `;

            renderComparisonList(selectedProduct);
            recordProductSearch(selectedProduct.id);
        }

        async function recordProductSearch(productId) {
            try {
                const response = await fetch('/api/search-events', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        product_id: productId,
                        latitude: currentUserLocation.lat,
                        longitude: currentUserLocation.lng
                    })
                });
                if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error || 'No se pudo registrar la búsqueda.');
                }
            } catch (error) {
                const message = document.getElementById('search-message');
                message.textContent = `No se pudo registrar la búsqueda para las métricas: ${error.message}`;
                message.classList.remove('hidden');
            }
        }

        function renderComparisonList(product) {
            const container = document.getElementById('stores-list');
            container.innerHTML = '';

            // Map data, calculate distance, and get pricing
            let storeOptions = STORES.map(store => {
                const invData = INVENTORY[`${store.id}_${product.id}`];
                const distance = calculateDistance(currentUserLocation.lat, currentUserLocation.lng, store.lat, store.lng);
                
                return {
                    ...store,
                    price: invData ? invData.price : Infinity,
                    hasStock: invData ? invData.stock : false,
                    distance: parseFloat(distance)
                };
            }).filter(s => s.price !== Infinity); // Only show stores that theoretically carry it

            // Logic to find the best option: Available in stock + Cheapest
            const inStockOptions = storeOptions.filter(s => s.hasStock);
            const cheapestPrice = inStockOptions.length > 0 ? Math.min(...inStockOptions.map(s => s.price)) : 0;

            // Sort: In-stock first, then by price (ascending), then by distance
            storeOptions.sort((a, b) => {
                if (a.hasStock === b.hasStock) {
                    if(a.price === b.price) return a.distance - b.distance;
                    return a.price - b.price;
                }
                return a.hasStock ? -1 : 1;
            });

            // Update Map Pins
            updateMapPinsForProduct(storeOptions, cheapestPrice);

            // Render Cards
            storeOptions.forEach((store, index) => {
                const isBestOption = store.hasStock && store.price === cheapestPrice;
                const outOfStock = !store.hasStock;
                
                let badgeHTML = '';
                let borderClass = 'border-gray-200';
                
                if (isBestOption) {
                    badgeHTML = `<div class="absolute -top-3 -right-2 bg-gradient-to-r from-orange-400 to-red-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-md animate-bounce"><i class="fa-solid fa-fire mr-1"></i> Mejor Opción</div>`;
                    borderClass = 'border-primary ring-2 ring-primary/20 bg-green-50/30';
                }

                const card = document.createElement('div');
                card.className = `relative bg-white rounded-xl p-4 border transition-all hover:shadow-lg ${borderClass} ${outOfStock ? 'opacity-70' : ''}`;
                
                card.innerHTML = `
                    ${badgeHTML}
                    <div class="flex justify-between items-start mb-2">
                        <div class="flex items-center gap-2">
                            <div class="${store.bgBrand} ${store.brandColor} w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm">
                                ${store.logo}
                            </div>
                            <div>
                                <h4 class="font-bold text-gray-800 text-sm">${store.name}</h4>
                                <p class="text-xs text-gray-500"><i class="fa-solid fa-route mr-1"></i> a ${store.distance} km de ti</p>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-xl font-bold ${outOfStock ? 'text-gray-400 line-through' : (isBestOption ? 'text-green-600' : 'text-gray-900')}">
                                ${formatCurrency(store.price)}
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                        <div class="text-xs font-medium ${outOfStock ? 'text-red-500' : 'text-emerald-600'} flex items-center gap-1">
                            <i class="fa-solid ${outOfStock ? 'fa-circle-xmark' : 'fa-circle-check'}"></i>
                            ${outOfStock ? 'Agotado (último registro)' : 'Disponible (último registro)'}
                        </div>
                        <button onclick="flyToStore(${store.lat}, ${store.lng})" class="text-xs font-semibold text-primary hover:text-secondary px-3 py-1.5 bg-primary/10 rounded-lg transition" ${outOfStock ? 'disabled' : ''}>
                            Ver en Mapa <i class="fa-solid fa-arrow-right ml-1"></i>
                        </button>
                    </div>
                `;
                
                // Add event listener to highlight map marker on hover
                card.addEventListener('mouseenter', () => highlightMarker(store.id));
                card.addEventListener('mouseleave', () => resetMarkerHighlight(store.id));

                container.appendChild(card);
            });
        }

        function resetView() {
            document.getElementById('search-input').value = '';
            document.getElementById('search-message').classList.add('hidden');
            document.getElementById('initial-state').classList.remove('hidden');
            document.getElementById('comparison-state').classList.add('hidden');
            selectedProduct = null;
            showAllStoresOnMap();
        }

        // --- Map Manipulation ---
        let productMapMarkers = {};

        function clearStoreMarkers() {
            storeMarkers.forEach(m => map.removeLayer(m));
            storeMarkers = [];
            productMapMarkers = {};
        }

        function showAllStoresOnMap() {
            if (!map || map.getSize().x === 0 || map.getSize().y === 0) return;

            clearStoreMarkers();
            
            // Adjust map bounds to include user and all stores
            const bounds = L.latLngBounds([[currentUserLocation.lat, currentUserLocation.lng]]);
            
            STORES.forEach(store => {
                const marker = createStoreMarker(store);
                bounds.extend([store.lat, store.lng]);
            });
            
            map.fitBounds(bounds, { padding: [50, 50] });
            document.getElementById('map-status').innerText = "Mostrando todas las tiendas";
        }

        function updateMapPinsForProduct(storeOptions, cheapestPrice) {
            if (!map || map.getSize().x === 0 || map.getSize().y === 0) return;
            clearStoreMarkers();
            
            const bounds = L.latLngBounds([[currentUserLocation.lat, currentUserLocation.lng]]);
            
            storeOptions.forEach(store => {
                if(!store.hasStock) return; // Don't pin out of stock

                const isBest = store.price === cheapestPrice;
                
                // Custom Icon based on store and price
                const htmlContent = `
                    <div id="marker-${store.id}" class="relative flex flex-col items-center transform transition-transform duration-300 ${isBest ? 'scale-125 z-50' : 'scale-100 z-10'}">
                        <div class="bg-white rounded-lg shadow-lg border-2 ${isBest ? 'border-primary' : 'border-gray-300'} px-2 py-1 text-center font-bold text-sm whitespace-nowrap">
                            ${isBest ? '<i class="fa-solid fa-star text-yellow-400 text-xs"></i> ' : ''}
                            ${formatCurrency(store.price)}
                        </div>
                        <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] ${isBest ? 'border-t-primary' : 'border-t-white'} -mt-[1px]"></div>
                        <div class="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-xs font-bold ${store.bgBrand} ${store.brandColor} -mt-1">
                            ${store.logo}
                        </div>
                    </div>
                `;

                const icon = L.divIcon({
                    className: 'custom-store-icon',
                    html: htmlContent,
                    iconSize: [60, 60],
                    iconAnchor: [30, 60],
                    popupAnchor: [0, -60]
                });

                const marker = L.marker([store.lat, store.lng], { icon }).addTo(map);
                
                const popupContent = `
                    <div class="p-3 text-center custom-popup min-w-[150px]">
                        <h4 class="font-bold text-gray-800 text-sm mb-1">${store.name}</h4>
                        <p class="text-xs text-gray-500 mb-2">${store.address}</p>
                        <div class="bg-gray-50 rounded-lg p-2 flex justify-between items-center">
                            <span class="text-xs text-gray-600">Precio:</span>
                            <span class="font-bold text-primary">${formatCurrency(store.price)}</span>
                        </div>
                        <button onclick="window.open('https://www.google.com/maps/dir/?api=1&origin=${currentUserLocation.lat},${currentUserLocation.lng}&destination=${store.lat},${store.lng}', '_blank')" class="mt-3 w-full bg-primary text-white py-1.5 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                            <i class="fa-solid fa-location-arrow mr-1"></i> Ir allá
                        </button>
                    </div>
                `;
                
                marker.bindPopup(popupContent, { maxWidth: 200, className: 'custom-popup-container' });
                
                storeMarkers.push(marker);
                productMapMarkers[store.id] = marker;
                bounds.extend([store.lat, store.lng]);
            });

            // Re-center map to fit user and available stores
            if(storeMarkers.length > 0) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
            }
            
            document.getElementById('map-status').innerHTML = `<span class="font-bold">${storeMarkers.length}</span> tiendas con stock`;
        }

        function updateMapPinsForList(storeTotals, lowestTotal, foundCount) {
            if (!map || map.getSize().x === 0 || map.getSize().y === 0) return;

            clearStoreMarkers();

            const bounds = L.latLngBounds([[currentUserLocation.lat, currentUserLocation.lng]]);

            storeTotals.forEach(({ store, total, availableCount, priceCount }) => {
                const isLowest = lowestTotal !== null
                    && availableCount === foundCount
                    && total === lowestTotal;
                const totalLabel = availableCount > 0
                    ? formatCurrency(total)
                    : priceCount > 0 ? 'Sin productos disponibles' : 'Sin datos';
                const htmlContent = `
                    <div id="marker-${store.id}" class="relative flex flex-col items-center transform transition-transform duration-300 ${isLowest ? 'scale-125 z-50' : 'scale-100 z-10'}">
                        <div class="bg-white rounded-lg shadow-lg border-2 ${isLowest ? 'border-primary' : 'border-gray-300'} px-2 py-1 text-center font-bold text-sm whitespace-nowrap">
                            ${isLowest ? '<i class="fa-solid fa-star text-yellow-400 text-xs"></i> ' : ''}
                            ${totalLabel}
                        </div>
                        <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] ${isLowest ? 'border-t-primary' : 'border-t-white'} -mt-[1px]"></div>
                        <div class="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-xs font-bold ${store.bgBrand} ${store.brandColor} -mt-1">
                            ${store.logo}
                        </div>
                    </div>
                `;
                const icon = L.divIcon({
                    className: 'custom-store-icon',
                    html: htmlContent,
                    iconSize: [80, 60],
                    iconAnchor: [40, 60],
                    popupAnchor: [0, -60]
                });
                const marker = L.marker([store.lat, store.lng], { icon }).addTo(map);
                marker.bindPopup(`
                    <div class="p-3 text-center custom-popup min-w-[150px]">
                        <h4 class="font-bold text-gray-800 text-sm mb-1">${store.name}</h4>
                        <p class="text-xs text-gray-500 mb-2">${store.address}</p>
                        <div class="bg-gray-50 rounded-lg p-2 flex justify-between items-center">
                            <span class="text-xs text-gray-600">Total de la lista:</span>
                            <span class="font-bold text-primary">${isLowest ? '<i class="fa-solid fa-star text-yellow-400 mr-1"></i>' : ''}${availableCount > 0 ? formatCurrency(total) : priceCount > 0 ? 'Sin productos disponibles' : 'Sin datos de precios'}</span>
                        </div>
                        <p class="mt-2 text-xs text-gray-500">${availableCount} de ${foundCount} productos encontrados disponibles</p>
                        <button onclick="window.open('https://www.google.com/maps/dir/?api=1&origin=${currentUserLocation.lat},${currentUserLocation.lng}&destination=${store.lat},${store.lng}', '_blank')" class="mt-3 w-full bg-primary text-white py-1.5 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                            <i class="fa-solid fa-location-arrow mr-1"></i> Ir allá
                        </button>
                    </div>
                `, { maxWidth: 220, className: 'custom-popup-container' });

                storeMarkers.push(marker);
                productMapMarkers[store.id] = marker;
                bounds.extend([store.lat, store.lng]);
            });

            const bestStore = lowestTotal === null
                ? null
                : storeTotals.find(({ total, availableCount }) =>
                    availableCount === foundCount && total === lowestTotal
                );
            if (bestStore && productMapMarkers[bestStore.store.id]) {
                const bestMarker = productMapMarkers[bestStore.store.id];
                map.flyTo([bestStore.store.lat, bestStore.store.lng], 16, {
                    animate: true,
                    duration: 1.2
                });
                bestMarker.openPopup();
                document.getElementById('map-status').textContent =
                    `Menor total: ${bestStore.store.name} - ${formatCurrency(lowestTotal)}`;
            } else {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
                document.getElementById('map-status').textContent = 'Totales de la lista por supermercado';
            }
        }

        function createStoreMarker(store) {
            const htmlContent = `
                <div class="relative flex flex-col items-center">
                    <div class="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-xs font-bold ${store.bgBrand} ${store.brandColor}">
                        ${store.logo}
                    </div>
                </div>
            `;
            const icon = L.divIcon({
                className: 'custom-store-icon',
                html: htmlContent,
                iconSize: [32, 32],
                iconAnchor: [16, 16],
                popupAnchor: [0, -16]
            });
            
            const marker = L.marker([store.lat, store.lng], { icon }).addTo(map);
            marker.bindPopup(`<b>${store.name}</b><br><span class="text-xs">${store.address}</span>`);
            storeMarkers.push(marker);
            return marker;
        }

        function flyToStore(lat, lng) {
            map.flyTo([lat, lng], 16, {
                animate: true,
                duration: 1.5
            });
            
            // On mobile, scroll map into view if needed (basic responsive fix)
            if (window.innerWidth < 768) {
                document.querySelector('main').scrollTo({
                    top: document.querySelector('.w-full.md\\:w-7\\/12').offsetTop,
                    behavior: 'smooth'
                });
            }
        }

        function highlightMarker(storeId) {
            if(productMapMarkers[storeId]) {
                const el = document.getElementById(`marker-${storeId}`);
                if(el) {
                    el.classList.add('scale-110');
                    el.classList.remove('scale-100');
                }
            }
        }

        function resetMarkerHighlight(storeId) {
            if(productMapMarkers[storeId]) {
                const el = document.getElementById(`marker-${storeId}`);
                if(el) {
                    // Check if it's the best option (has scale-125 class natively)
                    if(!el.classList.contains('scale-125')) {
                        el.classList.remove('scale-110');
                        el.classList.add('scale-100');
                    }
                }
            }
        }
