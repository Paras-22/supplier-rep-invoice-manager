import React, { useState, useMemo, useEffect } from "react";
import { Search, Star, AlertTriangle, TrendingUp, History, Landmark, DollarSign, PlusCircle, Bookmark, CheckCircle, Package } from "lucide-react";
import { collection, doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Product, Rep, PriceEntry } from "../types";
import { motion } from "motion/react";

interface ProductCatalogProps {
  products: Product[];
  reps: Rep[];
  priceEntries: PriceEntry[];
  currentUserUid: string;
}

export default function ProductCatalog({ products, reps, priceEntries, currentUserUid }: ProductCatalogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  
  // Manual price logging state
  const [manualRepId, setManualRepId] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualPack, setManualPack] = useState("Single Unit");
  const [manualSuccess, setManualSuccess] = useState(false);

  // Stock Control State
  const [currentStockInput, setCurrentStockInput] = useState<string>("");
  const [minStockInput, setMinStockInput] = useState<string>("");
  const [stockSuccess, setStockSuccess] = useState(false);

  // Filter products by query
  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(p => 
      p.name.toLowerCase().includes(q) || 
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.id && p.id.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q))
    );
  }, [products, searchQuery]);

  // Selected product object
  const selectedProduct = useMemo(() => {
    return products.find(p => p.id === selectedProductId) || null;
  }, [products, selectedProductId]);

  // All price points recorded historically for selected product
  const productPriceHistory = useMemo(() => {
    if (!selectedProductId) return [];
    return priceEntries
      .filter(p => p.productId === selectedProductId)
      .sort((a, b) => {
        const timeA = a.effectiveDate?.seconds || new Date(a.effectiveDate).getTime() / 1000;
        const timeB = b.effectiveDate?.seconds || new Date(b.effectiveDate).getTime() / 1000;
        return timeB - timeA; // Descending
      });
  }, [priceEntries, selectedProductId]);

  // Map each rep's current (most recent) price for selected product
  const repCurrentPrices = useMemo(() => {
    if (!selectedProductId) return [];
    const latestPricesMap: { [repId: string]: PriceEntry } = {};
    
    // History is already sorted descending, so first encountered per rep is the latest
    productPriceHistory.forEach(entry => {
      if (!latestPricesMap[entry.repId]) {
        latestPricesMap[entry.repId] = entry;
      }
    });

    return Object.values(latestPricesMap);
  }, [productPriceHistory, selectedProductId]);

  // Identify lowest current price rep
  const lowestPriceRepId = useMemo(() => {
    if (repCurrentPrices.length === 0) return null;
    let cheapest = repCurrentPrices[0];
    repCurrentPrices.forEach(item => {
      if (item.price < cheapest.price) {
        cheapest = item;
      }
    });
    return cheapest.repId;
  }, [repCurrentPrices]);

  const handleToggleLowStock = async () => {
    if (!selectedProduct) return;
    const nextVal = !selectedProduct.lowStock;
    const docRef = doc(db, "products", selectedProduct.id);
    try {
      await updateDoc(docRef, { lowStock: nextVal, updatedAt: serverTimestamp() });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  // Synchronize inputs when selectedProduct changes
  useEffect(() => {
    if (selectedProduct) {
      setCurrentStockInput(selectedProduct.currentStock?.toString() ?? "0");
      setMinStockInput(selectedProduct.minStockLevel?.toString() ?? "0");
    } else {
      setCurrentStockInput("");
      setMinStockInput("");
    }
  }, [selectedProductId, selectedProduct]);

  const handleSaveStockLevels = async () => {
    if (!selectedProduct) return;
    try {
      const curStock = parseInt(currentStockInput) || 0;
      const minStock = parseInt(minStockInput) || 0;
      
      // Compute whether physical stock lies below threshold
      const isLowStock = curStock < minStock;
      
      const docRef = doc(db, "products", selectedProduct.id);
      await updateDoc(docRef, {
        currentStock: curStock,
        minStockLevel: minStock,
        lowStock: isLowStock,
        updatedAt: serverTimestamp()
      });

      setStockSuccess(true);
      setTimeout(() => setStockSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  const handleUpdatePreferredRep = async (repId: string) => {
    if (!selectedProduct) return;
    const docRef = doc(db, "products", selectedProduct.id);
    try {
      await updateDoc(docRef, { preferredRepId: repId || null, updatedAt: serverTimestamp() });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

  const handleManualPriceSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || !manualRepId || !manualPrice) return;

    try {
      const parsedPrice = parseFloat(manualPrice);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        alert("Please enter a valid positive dollar amount.");
        return;
      }

      const priceRef = doc(collection(db, "prices"));
      const pricePayload: PriceEntry = {
        id: priceRef.id,
        productId: selectedProduct.id,
        repId: manualRepId,
        price: parsedPrice,
        packSize: manualPack,
        effectiveDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };

      await setDoc(priceRef, pricePayload);
      setManualPrice("");
      setManualSuccess(true);
      setTimeout(() => setManualSuccess(false), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "prices_manual");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3" id="catalog_grid">
      
      {/* LEFT COLUMN: LIST AND SEARCH - COMPACT */}
      <div className="lg:col-span-4 bg-white rounded-md shadow-2xs border border-slate-200 p-3 flex flex-col h-[550px]" id="catalog_sidebar">
        
        <div className="mb-2">
          <h2 className="text-xs font-bold text-slate-850">Product Catalog Master</h2>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-none">Chapel Downs POS inventory list</p>
        </div>

        {/* SEARCH BAR - HIGH DENSITY */}
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            className="w-full text-[11px] pl-8 pr-2 py-1.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50/50"
            placeholder="Search products, barcodes, cats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* PRODUCTS LIST BODY - DENSE ROW PADDING */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-1" id="catalog_items_list">
          {filteredProducts.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-slate-400">
              No supermarket products found.
            </div>
          ) : (
            filteredProducts.map(p => {
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedProductId(p.id)}
                  className={`p-2 rounded border text-left cursor-pointer transition-all ${
                    selectedProductId === p.id 
                      ? "border-emerald-650 bg-emerald-50/30 font-medium" 
                      : "border-slate-100 hover:border-slate-250 hover:bg-slate-50/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-1 leading-tight">
                    <h3 className="text-[11px] font-semibold text-slate-800 line-clamp-1">{p.name}</h3>
                    {((p.currentStock !== undefined && p.minStockLevel !== undefined && p.currentStock < p.minStockLevel) || p.lowStock) && (
                      <span className="shrink-0 p-0.5 bg-rose-50 text-rose-650 rounded border border-rose-100" title="Low Stock Alert Tristate">
                        <AlertTriangle className="h-3 w-3 text-rose-600 animate-pulse" />
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-1 text-[9px] text-slate-400 font-mono">
                    <span>Code: {p.id}</span>
                    <span className="px-1 bg-slate-100 rounded text-slate-500 capitalize text-[8px]">{p.category || "General"}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* RIGHT COLUMN: DETAIL COMPARISONS - DESIGN HIGH DENSITY */}
      <div className="lg:col-span-8 space-y-3" id="catalog_detail_viewport">
        {selectedProduct ? (
          <div className="bg-white rounded-md shadow-2xs border border-slate-200 p-4 space-y-4 text-left">
            
            {/* PRODUCT HEADER TRACE */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-150">
              <div>
                <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">{selectedProduct.category || "General Inventory"}</span>
                <h1 className="text-base font-bold text-slate-900 mt-1 leading-snug">{selectedProduct.name}</h1>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5">POS SKU Barcode: {selectedProduct.id}</p>
              </div>

              {/* ACTION TOGGLES */}
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={handleToggleLowStock}
                  className={`px-2 py-1 text-[10px] font-semibold rounded flex items-center gap-1.5 cursor-pointer transition-all ${
                    selectedProduct.lowStock
                      ? "bg-amber-100 text-amber-900 border border-amber-200"
                      : "bg-slate-100 border border-slate-250 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>{selectedProduct.lowStock ? "Low Stock: Active" : "Flag Low Stock"}</span>
                </button>
              </div>
            </div>

            {/* STOCK LEVEL & SAFETY THRESHOLDS RULE */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="col-span-1 flex items-center gap-1.5">
                <Package className="h-4 w-4 text-emerald-705" />
                <h3 className="text-[11px] font-bold text-slate-800">Stock Control Levels</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Current On-Hand Stock</label>
                  <input
                    type="number"
                    min="0"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 15"
                    value={currentStockInput}
                    onChange={(e) => setCurrentStockInput(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Minimum Stock Level (Safety threshold)</label>
                  <input
                    type="number"
                    min="0"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 10"
                    value={minStockInput}
                    onChange={(e) => setMinStockInput(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[9px]">
                  {parseInt(currentStockInput) < parseInt(minStockInput) ? (
                    <span className="text-rose-700 font-bold flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 animate-pulse" />
                      <span>Warning: Stock fell below threshold!</span>
                    </span>
                  ) : (
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      <span>Stock level is compliant</span>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSaveStockLevels}
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-bold rounded cursor-pointer transition-all shadow-2xs"
                >
                  Save Stock Rules
                </button>
              </div>
              {stockSuccess && (
                <div className="text-[9px] text-emerald-800 font-bold bg-emerald-50 border border-emerald-110 p-1 text-center rounded animate-pulse">
                  Inventory levels synchronized successfully!
                </div>
              )}
            </div>

            {/* PREFERRED SUPPLIER CHOICE */}
            <div className="p-2.5 bg-amber-50/50 rounded border border-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start gap-1.5">
                <Bookmark className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-[11px] font-bold text-amber-900">Preferred Auckland Representative</h3>
                  <p className="text-[9px] text-amber-700 leading-none">Which supplier rep is default/preferred for deliveries?</p>
                </div>
              </div>
              <div className="sm:w-56">
                <select
                  className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded text-amber-900 font-sans focus:outline-none"
                  value={selectedProduct.preferredRepId || ""}
                  onChange={(e) => handleUpdatePreferredRep(e.target.value)}
                >
                  <option value="">-- Set Preferred Rep --</option>
                  {reps.map(r => (
                    <option key={r.id} value={r.id}>{r.name} ({r.company})</option>
                  ))}
                </select>
              </div>
            </div>

            {/* SUPPLIER PRICE COMPARISONS GRID */}
            <div className="space-y-2">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <Landmark className="h-3.5 w-3.5 text-emerald-600" />
                <span>Supplier Quote Comparison</span>
              </h3>

              {repCurrentPrices.length === 0 ? (
                <div className="py-6 bg-slate-50/50 border border-slate-100 rounded text-center text-[10px] text-slate-400">
                  No active rep quotes logged. Upload an invoice docket or log prices below.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {repCurrentPrices.map(entry => {
                    const matchedRep = reps.find(r => r.id === entry.repId);
                    const isCheapest = entry.repId === lowestPriceRepId;
                    const isPreferred = entry.repId === selectedProduct.preferredRepId;
                    
                    return (
                      <div 
                        key={entry.id}
                        className={`p-2.5 rounded border relative flex flex-col justify-between ${
                          isCheapest 
                            ? "border-emerald-500 bg-emerald-50/10" 
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        {/* BADGES */}
                        <div className="absolute top-2.5 right-2.5 flex gap-1 items-center">
                          {isPreferred && (
                            <span className="p-0.5 bg-amber-100 text-amber-800 rounded-full" title="Preferred Rep">
                              <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />
                            </span>
                          )}
                          {isCheapest && (
                            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 text-[8px] font-bold rounded uppercase tracking-wider">
                              Cheapest
                            </span>
                          )}
                        </div>

                        <div>
                          <p className="text-[8px] font-mono text-slate-450 uppercase tracking-tight">{matchedRep?.company || "Unknown Company"}</p>
                          <h4 className="text-[11px] font-bold text-slate-800 mt-0.5">{matchedRep?.name || "Independent rep"}</h4>
                          
                          <div className="flex items-baseline gap-0.5 mt-1.5">
                            <span className="text-[15px] font-extrabold text-slate-900">${entry.price.toFixed(2)}</span>
                            <span className="text-[9px] text-slate-400">/{entry.packSize || "unit"}</span>
                          </div>
                        </div>

                        <div className="mt-2 pt-1 border-t border-slate-100 flex items-center justify-between text-[8px] text-slate-400">
                          <span>Updated: {new Date(entry.effectiveDate?.seconds ? entry.effectiveDate.seconds * 1000 : entry.effectiveDate).toLocaleDateString()}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* FULL PRICE HISTORY TIMELINE */}
            <div className="space-y-2 pt-2 border-t border-slate-150">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <History className="h-3.5 w-3.5 text-emerald-600" />
                <span>Auditable Cost Timeline (Historical entries kept forever)</span>
              </h3>

              {productPriceHistory.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic">No historic entries recorded sequentially.</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1" id="cost_timeline_list">
                  {productPriceHistory.map(entry => {
                    const r = reps.find(rep => rep.id === entry.repId);
                    const formattedDate = new Date(entry.createdAt?.seconds ? entry.createdAt.seconds * 1000 : entry.createdAt).toLocaleDateString() + " " + new Date(entry.createdAt?.seconds ? entry.createdAt.seconds * 1050 : entry.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    return (
                      <div key={entry.id} className="flex items-center justify-between p-1.5 bg-slate-50 border border-slate-150 rounded text-[10px]">
                        <div className="space-y-0.5">
                          <p className="font-bold text-slate-700">{r ? `${r.name} (${r.company})` : "Standalone Update"}</p>
                          <p className="text-[8px] text-slate-400 leading-none">Recorded: {formattedDate}</p>
                        </div>
                        <div className="text-right leading-tight">
                          <p className="font-extrabold text-emerald-800">${entry.price.toFixed(2)}</p>
                          <p className="text-[8px] text-slate-400 font-mono">{entry.packSize || "Single Unit"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* MANUAL PRICE LOGGING FORM */}
            <form onSubmit={handleManualPriceSave} className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1">
                <PlusCircle className="h-4 w-4 text-emerald-700" />
                <h4 className="text-[11px] font-bold text-slate-800">Manually Log Representative Quote</h4>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400" htmlFor="manual_rep_id">Supplier Rep</label>
                  <select
                    id="manual_rep_id"
                    required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500 font-sans"
                    value={manualRepId}
                    onChange={(e) => setManualRepId(e.target.value)}
                  >
                    <option value="">-- Choose Rep --</option>
                    {reps.map(r => (
                      <option key={r.id} value={r.id}>{r.name} ({r.company})</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400" htmlFor="manual_price_input">Wholesale Price ($)</label>
                  <input
                    id="manual_price_input"
                    type="number"
                    step="0.01"
                    required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 3.45"
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                  />
                </div>

                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400" htmlFor="manual_pack_input">Pack / Box size</label>
                  <input
                    id="manual_pack_input"
                    type="text"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500"
                    placeholder="e.g. Box of 24"
                    value={manualPack}
                    onChange={(e) => setManualPack(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                {manualSuccess ? (
                  <div className="flex items-center gap-1 text-emerald-700 text-[10px] font-semibold">
                    <CheckCircle className="h-3.5 w-3.5" />
                    <span>Price logged sequentially!</span>
                  </div>
                ) : (
                  <div></div>
                )}
                <button
                  type="submit"
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer transition-all shadow-2xs"
                >
                  Log Price Entry
                </button>
              </div>
            </form>

          </div>
        ) : (
          <div className="bg-white rounded-md shadow-2xs border border-slate-200 p-12 text-center text-slate-400 flex flex-col items-center justify-center h-[550px]" id="catalog_empty_detail">
            <Search className="h-8 w-8 text-slate-300 mb-2" />
            <h3 className="text-xs font-bold text-slate-700 font-sans">Select a Supermarket Product</h3>
            <p className="text-[10px] text-slate-405 mt-1 max-w-xs leading-normal">
              Select an item from the master inventory list on the left to audit cost trajectories, identify cheapest matching quotes, or log telephone price updates.
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
