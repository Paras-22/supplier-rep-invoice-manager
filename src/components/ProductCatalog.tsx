import React, { useState, useMemo, useEffect } from "react";
import { Search, Star, AlertTriangle, History, Landmark, PlusCircle, Bookmark, CheckCircle, Package } from "lucide-react";
import { collection, doc, setDoc, updateDoc, serverTimestamp, query, where, getDocs, limit } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Product, Rep, PriceEntry } from "../types";
import { motion } from "motion/react";

interface ProductCatalogProps {
  reps: Rep[];
  priceEntries: PriceEntry[];
  currentUserUid: string;
}

export default function ProductCatalog({ reps, priceEntries, currentUserUid }: ProductCatalogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [manualRepId, setManualRepId] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualPack, setManualPack] = useState("Single Unit");
  const [manualSuccess, setManualSuccess] = useState(false);
  const [currentStockInput, setCurrentStockInput] = useState<string>("");
  const [minStockInput, setMinStockInput] = useState<string>("");
  const [stockSuccess, setStockSuccess] = useState(false);

  useEffect(() => {
    const searchProducts = async () => {
      if (!searchQuery.trim() || searchQuery.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const q = searchQuery.trim().toUpperCase();
        const snapshot = await getDocs(
          query(
            collection(db, "products"),
            where("name", ">=", q),
            where("name", "<=", q + "\uf8ff"),
            limit(20)
          )
        );
        const results: Product[] = [];
        snapshot.forEach(doc => {
          results.push({ id: doc.id, ...doc.data() } as Product);
        });
        setSearchResults(results);
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(searchProducts, 400);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  const selectedProduct = useMemo(() => {
    return searchResults.find(p => p.id === selectedProductId) || null;
  }, [searchResults, selectedProductId]);

  const productPriceHistory = useMemo(() => {
    if (!selectedProductId) return [];
    return priceEntries
      .filter(p => p.productId === selectedProductId)
      .sort((a, b) => {
        const timeA = a.effectiveDate?.seconds || new Date(a.effectiveDate).getTime() / 1000;
        const timeB = b.effectiveDate?.seconds || new Date(b.effectiveDate).getTime() / 1000;
        return timeB - timeA;
      });
  }, [priceEntries, selectedProductId]);

  const repCurrentPrices = useMemo(() => {
    if (!selectedProductId) return [];
    const latestPricesMap: { [repId: string]: PriceEntry } = {};
    productPriceHistory.forEach(entry => {
      if (!latestPricesMap[entry.repId]) {
        latestPricesMap[entry.repId] = entry;
      }
    });
    return Object.values(latestPricesMap);
  }, [productPriceHistory, selectedProductId]);

  const lowestPriceRepId = useMemo(() => {
    if (repCurrentPrices.length === 0) return null;
    let cheapest = repCurrentPrices[0];
    repCurrentPrices.forEach(item => {
      if (item.price < cheapest.price) cheapest = item;
    });
    return cheapest.repId;
  }, [repCurrentPrices]);

  const handleToggleLowStock = async () => {
    if (!selectedProduct) return;
    const docRef = doc(db, "products", selectedProduct.id);
    try {
      await updateDoc(docRef, { lowStock: !selectedProduct.lowStock, updatedAt: serverTimestamp() });
      setSearchResults(prev => prev.map(p => p.id === selectedProduct.id ? { ...p, lowStock: !p.lowStock } : p));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedProduct.id}`);
    }
  };

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
      const isLowStock = curStock < minStock;
      const docRef = doc(db, "products", selectedProduct.id);
      await updateDoc(docRef, {
        currentStock: curStock,
        minStockLevel: minStock,
        lowStock: isLowStock,
        updatedAt: serverTimestamp()
      });
      setSearchResults(prev => prev.map(p =>
        p.id === selectedProduct.id ? { ...p, currentStock: curStock, minStockLevel: minStock, lowStock: isLowStock } : p
      ));
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
      setSearchResults(prev => prev.map(p =>
        p.id === selectedProduct.id ? { ...p, preferredRepId: repId || null } : p
      ));
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
      <div className="lg:col-span-4 bg-white rounded-md shadow-sm border border-slate-200 p-3 flex flex-col h-[550px]">
        <div className="mb-2">
          <h2 className="text-xs font-bold text-slate-800">Product Catalog</h2>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-none">Search Chapel Downs inventory</p>
        </div>

        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            className="w-full text-[11px] pl-8 pr-2 py-1.5 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-slate-50/50"
            placeholder="Type product name to search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {isSearching ? (
            <div className="py-8 text-center text-[11px] text-slate-400">Searching...</div>
          ) : !searchQuery.trim() ? (
            <div className="py-8 text-center text-[11px] text-slate-400">
              <Search className="h-6 w-6 mx-auto mb-2 text-slate-300" />
              Type a product name to search
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-8 text-center text-[11px] text-slate-400">
              No products found for "{searchQuery}"
            </div>
          ) : (
            searchResults.map(p => (
              <div
                key={p.id}
                onClick={() => setSelectedProductId(p.id)}
                className={`p-2 rounded border text-left cursor-pointer transition-all ${
                  selectedProductId === p.id
                    ? "border-emerald-500 bg-emerald-50/30 font-medium"
                    : "border-slate-100 hover:border-slate-250 hover:bg-slate-50/50"
                }`}
              >
                <div className="flex items-start justify-between gap-1 leading-tight">
                  <h3 className="text-[11px] font-semibold text-slate-800 line-clamp-1">{p.name}</h3>
                  {p.lowStock && <AlertTriangle className="h-3 w-3 text-rose-500 shrink-0 animate-pulse" />}
                </div>
                <div className="flex items-center justify-between mt-1 text-[9px] text-slate-400 font-mono">
                  <span>Code: {p.id}</span>
                  <span className="px-1 bg-slate-100 rounded text-slate-500 capitalize text-[8px]">{p.category || "General"}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="lg:col-span-8 space-y-3">
        {selectedProduct ? (
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-4 space-y-4 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-150">
              <div>
                <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                  {selectedProduct.category || "General"}
                </span>
                <h1 className="text-base font-bold text-slate-900 mt-1 leading-snug">{selectedProduct.name}</h1>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5">POS SKU Barcode: {selectedProduct.id}</p>
              </div>
              <button
                onClick={handleToggleLowStock}
                className={`px-2 py-1 text-[10px] font-semibold rounded flex items-center gap-1.5 cursor-pointer transition-all ${
                  selectedProduct.lowStock
                    ? "bg-amber-100 text-amber-900 border border-amber-200"
                    : "bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200"
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{selectedProduct.lowStock ? "Low Stock: Active" : "Flag Low Stock"}</span>
              </button>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Package className="h-4 w-4 text-emerald-600" />
                <h3 className="text-[11px] font-bold text-slate-800">Stock Control Levels</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Current On-Hand Stock</label>
                  <input
                    type="number" min="0"
                    className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 15"
                    value={currentStockInput}
                    onChange={(e) => setCurrentStockInput(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Minimum Stock Level</label>
                  <input
                    type="number" min="0"
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
                      <span>Stock below threshold!</span>
                    </span>
                  ) : (
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      <span>Stock level compliant</span>
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSaveStockLevels}
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-bold rounded cursor-pointer transition-all"
                >
                  Save Stock Rules
                </button>
              </div>
              {stockSuccess && (
                <div className="text-[9px] text-emerald-800 font-bold bg-emerald-50 border border-emerald-200 p-1 text-center rounded">
                  Inventory levels saved!
                </div>
              )}
            </div>

            <div className="p-2.5 bg-amber-50/50 rounded border border-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start gap-1.5">
                <Bookmark className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-[11px] font-bold text-amber-900">Preferred Representative</h3>
                  <p className="text-[9px] text-amber-700 leading-none">Default supplier for this product</p>
                </div>
              </div>
              <div className="sm:w-56">
                <select
                  className="w-full text-[10px] bg-white border border-slate-200 p-1.5 rounded text-amber-900 focus:outline-none"
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

            <div className="space-y-2">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <Landmark className="h-3.5 w-3.5 text-emerald-600" />
                <span>Supplier Quote Comparison</span>
              </h3>
              {repCurrentPrices.length === 0 ? (
                <div className="py-6 bg-slate-50/50 border border-slate-100 rounded text-center text-[10px] text-slate-400">
                  No rep quotes logged yet. Upload a docket or log prices below.
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
                          isCheapest ? "border-emerald-500 bg-emerald-50/10" : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="absolute top-2.5 right-2.5 flex gap-1 items-center">
                          {isPreferred && <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />}
                          {isCheapest && (
                            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 text-[8px] font-bold rounded uppercase">
                              Cheapest
                            </span>
                          )}
                        </div>
                        <div>
                          <p className="text-[8px] font-mono text-slate-400 uppercase tracking-tight">
                            {matchedRep?.company || "Unknown"}
                          </p>
                          <h4 className="text-[11px] font-bold text-slate-800 mt-0.5">
                            {matchedRep?.name || "Unknown Rep"}
                          </h4>
                          <div className="flex items-baseline gap-0.5 mt-1.5">
                            <span className="text-[15px] font-extrabold text-slate-900">${entry.price.toFixed(2)}</span>
                            <span className="text-[9px] text-slate-400">/{entry.packSize || "unit"}</span>
                          </div>
                        </div>
                        <div className="mt-2 pt-1 border-t border-slate-100 text-[8px] text-slate-400">
                          Updated: {new Date(entry.effectiveDate?.seconds ? entry.effectiveDate.seconds * 1000 : entry.effectiveDate).toLocaleDateString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-150">
              <h3 className="text-[11px] font-bold text-slate-700 flex items-center gap-1">
                <History className="h-3.5 w-3.5 text-emerald-600" />
                <span>Price History (kept forever)</span>
              </h3>
              {productPriceHistory.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic">No price history recorded yet.</p>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {productPriceHistory.map(entry => {
                    const r = reps.find(rep => rep.id === entry.repId);
                    return (
                      <div key={entry.id} className="flex items-center justify-between p-1.5 bg-slate-50 border border-slate-150 rounded text-[10px]">
                        <div className="space-y-0.5">
                          <p className="font-bold text-slate-700">{r ? `${r.name} (${r.company})` : "Manual Entry"}</p>
                          <p className="text-[8px] text-slate-400">
                            {new Date(entry.createdAt?.seconds ? entry.createdAt.seconds * 1000 : entry.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-extrabold text-emerald-800">${entry.price.toFixed(2)}</p>
                          <p className="text-[8px] text-slate-400 font-mono">{entry.packSize || "Single Unit"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <form onSubmit={handleManualPriceSave} className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2.5">
              <div className="flex items-center gap-1">
                <PlusCircle className="h-4 w-4 text-emerald-700" />
                <h4 className="text-[11px] font-bold text-slate-800">Manually Log Representative Quote</h4>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Supplier Rep</label>
                  <select
                    required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500"
                    value={manualRepId}
                    onChange={(e) => setManualRepId(e.target.value)}
                  >
                    <option value="">-- Choose Rep --</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name} ({r.company})</option>)}
                  </select>
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Wholesale Price ($)</label>
                  <input
                    type="number" step="0.01" required
                    className="w-full text-[10px] bg-white border border-slate-200 p-1 rounded focus:outline-none focus:border-emerald-500 font-mono"
                    placeholder="e.g. 3.45"
                    value={manualPrice}
                    onChange={(e) => setManualPrice(e.target.value)}
                  />
                </div>
                <div className="space-y-0.5">
                  <label className="text-[8px] uppercase font-bold text-slate-400">Pack / Box Size</label>
                  <input
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
                    <span>Price logged!</span>
                  </div>
                ) : <div></div>}
                <button
                  type="submit"
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-semibold rounded cursor-pointer transition-all"
                >
                  Log Price Entry
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-12 text-center text-slate-400 flex flex-col items-center justify-center h-[550px]">
            <Search className="h-8 w-8 text-slate-300 mb-2" />
            <h3 className="text-xs font-bold text-slate-700">Search for a Product</h3>
            <p className="text-[10px] text-slate-400 mt-1 max-w-xs leading-normal">
              Type a product name in the search box to find it and view supplier prices.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}