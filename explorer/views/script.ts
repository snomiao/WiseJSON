/**
 * explorer/views/script.ts
 * Frontend logic for the WiseJSON Data Explorer.
 */

interface CollectionInfo {
    name: string;
    count: number;
}

interface IndexInfo {
    fieldName: string;
    type: 'index' | 'unique';
}

interface ExplorerState {
    collections: CollectionInfo[];
    currentCollection: string | null;
    documents: any[];
    indexes: IndexInfo[];
    currentPage: number;
    pageSize: number;
    totalDocs: number;
    filter: Record<string, any>;
    sort: { field: string; order: 'asc' | 'desc' };
    writeMode: boolean;
}

document.addEventListener('DOMContentLoaded', () => {
    // --- State Initialization ---
    const state: ExplorerState = {
        collections: [],
        currentCollection: null,
        documents: [],
        indexes: [],
        currentPage: 0,
        pageSize: 10,
        totalDocs: 0,
        filter: {},
        sort: { field: '_id', order: 'asc' },
        writeMode: false,
    };

    // --- DOM Elements (Casting to specific types for TS safety) ---
    const dbMap = document.getElementById('dbMap') as any; // Custom Web Component
    const collectionSelect = document.getElementById('collectionSelect') as HTMLSelectElement;
    const queryBuilder = document.getElementById('queryBuilder') as any; // Custom Web Component
    const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;
    const applyBtn = document.getElementById('applyBtn') as HTMLButtonElement;
    const sortInput = document.getElementById('sortInput') as HTMLInputElement;
    const orderSelect = document.getElementById('orderSelect') as HTMLSelectElement;
    const pageSizeInput = document.getElementById('pageSizeInput') as HTMLInputElement;
    const prevBtn = document.getElementById('prevBtn') as HTMLButtonElement;
    const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
    const pageInfo = document.getElementById('pageInfo') as HTMLElement;
    const dataTable = document.getElementById('dataTable') as HTMLTableElement;
    const documentViewer = document.getElementById('documentViewer') as any; // Custom Viewer
    const indexList = document.getElementById('index-list') as HTMLElement;
    const indexFieldInput = document.getElementById('indexFieldInput') as HTMLInputElement;
    const uniqueCheckbox = document.getElementById('uniqueCheckbox') as HTMLInputElement;
    const createIndexBtn = document.getElementById('createIndexBtn') as HTMLButtonElement;
    const serverModeEl = document.getElementById('server-mode') as HTMLElement;

    /**
     * Display a UI toast notification.
     */
    function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
        const toastElement = document.getElementById('toastNotifications') as any;
        if (toastElement && typeof toastElement.show === 'function') {
            toastElement.show(message, type);
        } else {
            console.warn(`[${type.toUpperCase()}] ${message}`);
        }
    }

    /**
     * Typed API Fetcher
     */
    async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            return response.status === 204 ? ({} as T) : await response.json();
        } catch (error: any) {
            showToast(error.message, 'error');
            throw error;
        }
    }

    // --- Rendering Logic ---

    function renderCollections(): void {
        collectionSelect.innerHTML = '<option value="">-- Select a collection --</option>';
        state.collections.forEach(col => {
            const option = document.createElement('option');
            option.value = col.name;
            option.textContent = `${col.name} (${col.count} docs)`;
            collectionSelect.appendChild(option);
        });
        if (state.currentCollection) collectionSelect.value = state.currentCollection;
    }



    function renderDocuments(): void {
        const thead = dataTable.querySelector('thead')!;
        const tbody = dataTable.querySelector('tbody')!;
        thead.innerHTML = '';
        tbody.innerHTML = '';

        if (state.documents.length === 0) {
            tbody.innerHTML = '<tr><td colspan="100%">No documents found.</td></tr>';
            return;
        }

        // Dynamically build headers based on keys present in the current page sample
        const headers = new Set(['_actions']);
        state.documents.forEach(doc => Object.keys(doc).forEach(key => headers.add(key)));

        // Update Query Builder fields
        const fields = Array.from(headers).filter(h => h !== '_actions');
        if (queryBuilder.setFields) queryBuilder.setFields(fields);

        const headerRow = document.createElement('tr');
        headers.forEach(key => {
            const th = document.createElement('th');
            th.textContent = key;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);

        state.documents.forEach(doc => {
            const row = document.createElement('tr');
            row.onclick = () => {
                documentViewer.value = doc;
                dataTable.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
            };

            headers.forEach(header => {
                const td = document.createElement('td');
                if (header === '_actions') {
                    renderActionButtons(td, doc);
                } else {
                    const val = doc[header];
                    td.textContent = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val);
                }
                row.appendChild(td);
            });
            tbody.appendChild(row);
        });
    }

    function renderActionButtons(container: HTMLElement, doc: any): void {
        const viewBtn = document.createElement('button');
        viewBtn.textContent = 'View';
        viewBtn.onclick = (e) => { e.stopPropagation(); documentViewer.value = doc; };
        container.appendChild(viewBtn);

        if (state.writeMode) {
            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete';
            delBtn.className = 'delete-btn write-op';
            delBtn.onclick = (e) => { e.stopPropagation(); handleDeleteDocument(doc._id); };
            container.appendChild(delBtn);
        }
    }

    // --- Action Handlers ---

    async function loadCollectionData(name: string): Promise<void> {
        state.currentCollection = name;
        if (!name) return;

        const offset = state.currentPage * state.pageSize;
        const params = new URLSearchParams({
            limit: state.pageSize.toString(),
            offset: offset.toString(),
            sort: state.sort.field,
            order: state.sort.order,
            filter: JSON.stringify(state.filter)
        });

        const [docs, stats] = await Promise.all([
            apiFetch<any[]>(`/api/collections/${encodeURIComponent(name)}?${params}`),
            apiFetch<any>(`/api/collections/${encodeURIComponent(name)}/stats`)
        ]);

        state.documents = docs;
        state.indexes = stats.indexes || [];

        renderDocuments();
        renderPagination();
        updateWriteModeUI();
    }

    async function handleDeleteDocument(id: string): Promise<void> {
        if (!confirm(`Delete document ${id}?`)) return;
        await apiFetch(`/api/collections/${state.currentCollection}/doc/${encodeURIComponent(id)}`, { method: 'DELETE' });
        showToast('Document deleted', 'success');
        loadCollectionData(state.currentCollection!);
    }

    function renderPagination() {
        pageInfo.textContent = `Page ${state.currentPage + 1}`;
        prevBtn.disabled = state.currentPage === 0;
        nextBtn.disabled = state.documents.length < state.pageSize;
    }

    function updateWriteModeUI(): void {
        document.querySelectorAll<HTMLElement>('.write-op').forEach(el => {
            el.style.display = state.writeMode ? 'inline-flex' : 'none';
        });
        serverModeEl.textContent = state.writeMode ? 'Mode: Read/Write' : 'Mode: Read-Only';
        serverModeEl.className = state.writeMode ? 'mode-rw' : 'mode-ro';
    }

    // --- Event Listeners ---
    collectionSelect.onchange = () => {
        state.currentPage = 0;
        loadCollectionData(collectionSelect.value);
    };

    applyBtn.onclick = () => {
        state.sort.field = sortInput.value || '_id';
        state.sort.order = orderSelect.value as 'asc' | 'desc';
        state.pageSize = parseInt(pageSizeInput.value) || 10;
        state.currentPage = 0;
        if (state.currentCollection) loadCollectionData(state.currentCollection);
    };

    prevBtn.onclick = () => { if (state.currentPage > 0) { state.currentPage--; loadCollectionData(state.currentCollection!); } };
    nextBtn.onclick = () => { state.currentPage++; loadCollectionData(state.currentCollection!); };

    // --- Initialization ---
    (async () => {
        const [cols, graph, perms] = await Promise.all([
            apiFetch<CollectionInfo[]>('/api/collections'),
            apiFetch<any>('/api/schema-graph'),
            apiFetch<{ writeMode: boolean }>('/api/permissions')
        ]);
        state.collections = cols;
        state.writeMode = perms.writeMode;
        if (dbMap.render) dbMap.render(graph);
        renderCollections();
        updateWriteModeUI();
    })();
});
