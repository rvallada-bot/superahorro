(() => {
    let analytics = null;
    let historyChart = null;
    let heatLayer = null;
    let mobileView = 'list';
    let previousMobileState = null;
    let previousMapVisibility = null;

    document.addEventListener('DOMContentLoaded', setupTheme);
    document.addEventListener('catalog-ready', initializeAdvanced, { once: true });

    function initializeAdvanced() {
        document.getElementById('loading-skeleton').classList.add('hidden');
        const historyProduct = document.getElementById('history-product');
        historyProduct.replaceChildren();
        PRODUCTS.forEach(product => {
            const option = document.createElement('option');
            option.value = product.id;
            option.textContent = `${product.name} · ${product.brand}`;
            historyProduct.appendChild(option);
        });
        document.getElementById('admin-analytics').classList.toggle('hidden', !window.superAhorroIsAdmin);
        bindControls();
        updateMobileView();
    }

    function bindControls() {
        document.getElementById('history-product').addEventListener('change', () => loadAnalytics(
            document.getElementById('history-product').value
        ));
        document.getElementById('history-range').addEventListener('change', () => {
            if (analytics) renderHistoryChart(analytics.price_history);
        });
        document.getElementById('analytics-button').addEventListener('click', toggleAnalytics);
        document.getElementById('close-analytics').addEventListener('click', () => {
            document.getElementById('analytics-panel').classList.add('hidden');
        });
        document.getElementById('mobile-view-toggle').addEventListener('click', () => {
            mobileView = mobileView === 'list' ? 'map' : 'list';
            updateMobileView();
        });
        document.getElementById('show-heatmap').addEventListener('click', toggleHeatmap);
        document.getElementById('export-xlsx').addEventListener('click', exportExcel);
        document.getElementById('export-pdf').addEventListener('click', exportPdf);
        window.addEventListener('resize', updateMobileView);
    }

    function setupTheme() {
        const button = document.getElementById('dark-mode-button');
        const saved = localStorage.getItem('superahorro-theme');
        document.body.classList.toggle('dark', saved === 'dark');
        setThemeButton(button, saved === 'dark');
        button.addEventListener('click', () => {
            const dark = document.body.classList.toggle('dark');
            localStorage.setItem('superahorro-theme', dark ? 'dark' : 'light');
            setThemeButton(button, dark);
        });
    }

    function setThemeButton(button, dark) {
        button.innerHTML = dark
            ? '<i class="fa-solid fa-sun" aria-hidden="true"></i>'
            : '<i class="fa-solid fa-moon" aria-hidden="true"></i>';
        button.setAttribute('aria-label', dark ? 'Activar modo claro' : 'Activar modo oscuro');
    }

    function updateMobileView() {
        const listPanel = document.getElementById('list-panel');
        const mapPanel = document.getElementById('map-panel');
        const button = document.getElementById('mobile-view-toggle');
        const mobile = window.matchMedia('(max-width: 767px)').matches;
        const mapVisible = !mobile || mobileView === 'map';
        const mapVisibilityChanged = previousMapVisibility !== mapVisible;
        const breakpointChanged = previousMobileState !== mobile;
        previousMobileState = mobile;
        previousMapVisibility = mapVisible;

        if (!mobile) {
            listPanel.classList.remove('hidden');
            mapPanel.classList.remove('hidden');
            button.classList.add('hidden');
            if (mapVisibilityChanged || breakpointChanged) refreshMapWhenVisible();
            return;
        }

        button.classList.remove('hidden');
        listPanel.classList.toggle('hidden', mobileView === 'map');
        mapPanel.classList.toggle('hidden', mobileView !== 'map');
        button.innerHTML = mobileView === 'list'
            ? '<i class="fa-solid fa-map mr-2" aria-hidden="true"></i>Ver mapa'
            : '<i class="fa-solid fa-list mr-2" aria-hidden="true"></i>Ver lista';
        button.setAttribute('aria-label', mobileView === 'list' ? 'Cambiar a vista de mapa' : 'Cambiar a vista de lista');
        if (mapVisible && (mapVisibilityChanged || breakpointChanged)) refreshMapWhenVisible();
    }

    function refreshMapWhenVisible() {
        if (!window.superAhorroMap) return;
        setTimeout(() => {
            window.superAhorroMap.invalidateSize({ pan: false });
            if (selectedProduct) {
                renderComparisonList(selectedProduct);
            } else {
                showAllStoresOnMap();
            }
        }, 120);
    }

    function toggleAnalytics() {
        const panel = document.getElementById('analytics-panel');
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        if (opening) {
            document.getElementById('history-product').value = PRODUCTS[0]?.id || '';
            loadAnalytics(PRODUCTS[0]?.id);
        }
    }

    async function loadAnalytics(productId) {
        const notice = document.getElementById('history-notice');
        notice.textContent = 'Cargando informes...';
        try {
            const params = new URLSearchParams({
                lat: String(currentUserLocation.lat),
                lng: String(currentUserLocation.lng)
            });
            if (productId) params.set('product_id', productId);
            const response = await fetch(`/api/analytics?${params.toString()}`, { credentials: 'same-origin' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudieron cargar los informes.');
            analytics = data;
            notice.textContent =
                `${data.history_notice} El catálogo actual no informa ofertas activas ni cantidades de stock; se muestran disponibilidad registrada y precios observados.`;
            renderHistoryChart(data.price_history);
            renderInflation(data.inflation);
            if (data.admin) renderAdminAnalytics(data.admin);
        } catch (error) {
            notice.textContent = error.message;
        }
    }

    function renderHistoryChart(rows) {
        const canvas = document.getElementById('price-history-chart');
        if (historyChart) historyChart.destroy();
        const days = Number(document.getElementById('history-range').value);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        rows = rows.filter(row => new Date(row.recorded_at).getTime() >= cutoff);
        const storeNames = [...new Set(rows.map(row => row.store_name))];
        const labels = [...new Set(rows.map(row => row.recorded_at.slice(0, 10)))].sort();
        renderPriceAlerts(rows);
        if (!window.Chart || labels.length === 0) {
            document.getElementById('history-notice').textContent += labels.length === 0
                ? ' Aún no hay registros suficientes para graficar este producto.'
                : ' No se pudo cargar el componente de gráficos.';
            return;
        }
        const colors = ['#059669', '#2563eb', '#f97316', '#9333ea', '#dc2626'];
        historyChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: storeNames.map((store, index) => ({
                    label: store,
                    data: labels.map(date => {
                        const match = rows.filter(row =>
                            row.store_name === store && row.recorded_at.slice(0, 10) === date
                        ).pop();
                        return match ? match.price_clp : null;
                    }),
                    borderColor: colors[index % colors.length],
                    backgroundColor: colors[index % colors.length],
                    spanGaps: true,
                    tension: 0.25
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: { y: { ticks: { callback: value => formatCurrency(value) } } }
            }
        });
    }

    function renderPriceAlerts(rows) {
        const container = document.getElementById('price-alerts');
        container.replaceChildren();
        const productId = Number(document.getElementById('history-product').value);
        const storeNames = [...new Set(rows.map(row => row.store_name))];
        storeNames.forEach(storeName => {
            const history = rows.filter(row => row.store_name === storeName)
                .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
            const store = STORES.find(item => item.name === storeName);
            const current = store && INVENTORY[`${store.id}_${productId}`];
            if (!current) return;
            const lowest = Math.min(...history.map(row => row.price_clp));
            if (history.length >= 2 && current.price <= lowest) {
                appendPriceAlert(
                    `${storeName}: mínimo observado en los últimos ${document.getElementById('history-range').value} días (${formatCurrency(current.price)}).`,
                    'emerald'
                );
            }
            const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const prior = [...history].reverse().find(row => new Date(row.recorded_at).getTime() <= weekAgo);
            if (prior && prior.price_clp > 0 && current.price > prior.price_clp) {
                const increase = Math.round((current.price - prior.price_clp) / prior.price_clp * 100);
                appendPriceAlert(
                    `${storeName}: subió ${increase}% frente al último registro de hace al menos 7 días.`,
                    'amber'
                );
            }
        });
        if (!container.childElementCount) {
            appendPriceAlert('Sin suficientes observaciones anteriores para generar alertas de precio.', 'gray');
        }
    }

    function appendPriceAlert(text, color) {
        const colors = {
            emerald: 'bg-emerald-50 text-emerald-800',
            amber: 'bg-amber-50 text-amber-800',
            gray: 'bg-gray-50 text-gray-600'
        };
        const label = document.createElement('p');
        label.className = `rounded-lg px-3 py-2 text-xs ${colors[color]}`;
        label.textContent = text;
        document.getElementById('price-alerts').appendChild(label);
    }

    function renderInflation(categories) {
        const container = document.getElementById('category-inflation');
        container.replaceChildren();
        categories.forEach(item => {
            const row = document.createElement('p');
            row.className = 'flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs';
            const name = document.createElement('span');
            name.textContent = item.category;
            const change = document.createElement('strong');
            change.className = item.change_percent > 0 ? 'text-red-600' : 'text-emerald-700';
            change.textContent = item.enough_history && item.change_percent !== null
                ? `${item.change_percent > 0 ? '+' : ''}${item.change_percent}%`
                : 'Histórico insuficiente';
            row.append(name, change);
            container.appendChild(row);
        });
        if (!categories.length) {
            const empty = document.createElement('p');
            empty.className = 'text-xs text-gray-500';
            empty.textContent = 'Aún no hay precios suficientes para comparar categorías.';
            container.appendChild(empty);
        }
    }

    function renderAdminAnalytics(admin) {
        const report = document.getElementById('competitiveness-report');
        report.replaceChildren();
        const heading = document.createElement('p');
        heading.className = 'mb-2 font-semibold';
        heading.textContent = 'Índice de competitividad · precio promedio por cadena/categoría';
        report.appendChild(heading);
        admin.competitiveness.forEach(row => {
            const item = document.createElement('p');
            item.className = 'border-b border-gray-100 py-1';
            item.textContent =
                `${row.category} · ${row.chain}: ${formatCurrency(row.average_price)} (${row.products_count} registros)`;
            report.appendChild(item);
        });
    }

    function toggleHeatmap() {
        if (!analytics?.admin || !window.superAhorroMap) return;
        if (heatLayer) {
            window.superAhorroMap.removeLayer(heatLayer);
            heatLayer = null;
            document.getElementById('show-heatmap').textContent = 'Mostrar mapa de demanda';
            return;
        }
        heatLayer = L.layerGroup();
        const maxSearches = Math.max(1, ...analytics.admin.heatmap.map(point => point.searches));
        analytics.admin.heatmap.forEach(point => {
            L.circleMarker([point.lat, point.lng], {
                radius: 7 + 16 * point.searches / maxSearches,
                color: '#b91c1c',
                fillColor: '#ef4444',
                fillOpacity: 0.35,
                weight: 1
            }).bindPopup(`${point.searches} búsqueda(s) registradas`).addTo(heatLayer);
        });
        heatLayer.addTo(window.superAhorroMap);
        document.getElementById('show-heatmap').textContent = 'Ocultar mapa de demanda';
        mobileView = 'map';
        updateMobileView();
    }

    function exportExcel() {
        if (!analytics || !window.XLSX) {
            showAnalyticsError('No se pudo generar el Excel. Comprueba que la biblioteca de exportación esté disponible.');
            return;
        }
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(analytics.admin?.competitiveness || []),
            'Competitividad'
        );
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(analytics.admin?.heatmap || []),
            'Demanda aproximada'
        );
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet(analytics.inflation),
            'Variacion categorias'
        );
        XLSX.writeFile(workbook, 'informe-superahorro.xlsx');
    }

    function exportPdf() {
        const JsPDF = window.jspdf?.jsPDF;
        if (!analytics || !JsPDF) {
            showAnalyticsError('No se pudo generar el PDF. Comprueba que la biblioteca de exportación esté disponible.');
            return;
        }
        const doc = new JsPDF();
        doc.text('Informe SuperAhorro', 14, 16);
        const rows = (analytics.admin?.competitiveness || []).map(row => [
            row.category, row.chain, formatCurrency(row.average_price), row.products_count
        ]);
        if (typeof doc.autoTable !== 'function') {
            showAnalyticsError('La extensión de tablas PDF no está disponible. Revisa la conexión e inténtalo nuevamente.');
            return;
        }
        doc.autoTable({
            startY: 24,
            head: [['Categoría', 'Cadena', 'Precio promedio', 'Registros']],
            body: rows
        });
        doc.save('informe-superahorro.pdf');
    }

    function showAnalyticsError(message) {
        document.getElementById('history-notice').textContent = message;
    }
})();
