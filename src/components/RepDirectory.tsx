import React, { useState, useMemo } from "react";
import { Users as UsersIcon, Phone as PhoneIcon, Mail as MailIcon, FileText as FileTextIcon, Calendar as CalendarIcon, PlusCircle as PlusIcon, CheckCircle as CheckIcon, Calculator as CalcIcon, Package as PackIcon, AlertTriangle as AlertIcon, FileSpreadsheet as SheetIcon, Download as DownloadIcon, Copy as CopyIcon, Star as StarIcon, Printer as PrinterIcon, Loader2 as LoaderIcon, AlertCircle as AlertCircleIcon } from "lucide-react";
import { collection, doc, setDoc, addDoc, getDocs, updateDoc, serverTimestamp } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { Rep, Visit, Product, PriceEntry, Invoice } from "../types";
import { motion } from "motion/react";

interface RepDirectoryProps {
  reps: Rep[];
  visits: Visit[]; // flattened visits across reps
  products: Product[];
  priceEntries: PriceEntry[];
  invoices: Invoice[]; // and invoices
  onRepChange: () => void;
  currentUserUid: string;
}

export default function RepDirectory({ reps, visits, products, priceEntries, invoices, onRepChange, currentUserUid }: RepDirectoryProps) {
  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [copiedOrder, setCopiedOrder] = useState(false);
  const [showPrintReport, setShowPrintReport] = useState(false);

  // New Rep state
  const [newName, setNewName] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New Visit note state
  const [visitText, setVisitText] = useState("");
  const [visitSuccess, setVisitSuccess] = useState(false);

  // Draft ordering list state
  const [orderQtys, setOrderQtys] = useState<{ [prodId: string]: number }>({});

  const selectedRep = useMemo(() => {
    return reps.find(r => r.id === selectedRepId) || null;
  }, [reps, selectedRepId]);

  // Visit history of selected rep
  const repVisits = useMemo(() => {
    if (!selectedRepId) return [];
    return visits
      .filter(v => v.repId === selectedRepId)
      .sort((a, b) => {
        const timeA = a.visitDate?.seconds || new Date(a.visitDate).getTime() / 1000;
        const timeB = b.visitDate?.seconds || new Date(b.visitDate).getTime() / 1000;
        return timeB - timeA;
      });
  }, [visits, selectedRepId]);

  // List of product IDs currently supplied by this rep
  const repSuppliedProductIds = useMemo(() => {
    if (!selectedRepId) return [];
    const ids = new Set<string>();
    priceEntries.forEach(entry => {
      if (entry.repId === selectedRepId) {
        ids.add(entry.productId);
      }
    });
    return Array.from(ids);
  }, [priceEntries, selectedRepId]);

  // Map product entries supplied
  const suppliedProducts = useMemo(() => {
    return products.filter(p => repSuppliedProductIds.includes(p.id));
  }, [products, repSuppliedProductIds]);

  // Get current prices for supplied products
  const productCurrentPrices = useMemo(() => {
    const pricesMap: { [productId: string]: number } = {};
    priceEntries.forEach(entry => {
      if (entry.repId === selectedRepId) {
        // If multiple entries, compare date and keep latest
        const currentRef = pricesMap[entry.productId];
        if (!currentRef) {
          pricesMap[entry.productId] = entry.price;
        } else {
          // Keep most recent trace
          pricesMap[entry.productId] = entry.price; // simplified, snapshot fetches in chronological order
        }
      }
    });
    return pricesMap;
  }, [priceEntries, selectedRepId]);

  // Automatically compute items to pre-order: supplied items that are flagged Low Stock
  const lowStockSuppliedProducts = useMemo(() => {
    return suppliedProducts.filter(p => p.lowStock === true);
  }, [suppliedProducts]);

  // Weekly expense computation: last 7 days confirmed amounts
  const weeklyExpenseSummary = useMemo(() => {
    if (!selectedRepId) return { currentWeekTotal: 0, lifetimeSpent: 0 };
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let currentWeekTotal = 0;
    let lifetimeSpent = 0;

    invoices.forEach(inv => {
      if (inv.repId === selectedRepId && inv.status === "confirmed") {
        const value = inv.totalAmount || 0;
        lifetimeSpent += value;

        const invDateObj = new Date(inv.invoiceDate || inv.createdAt);
        if (invDateObj >= sevenDaysAgo) {
          currentWeekTotal += value;
        }
      }
    });

    return { currentWeekTotal, lifetimeSpent };
  }, [invoices, selectedRepId]);

  // Average Cost Change calculation
  const costChangeMetrics = useMemo(() => {
    if (!selectedRepId || suppliedProducts.length === 0) {
      return {
        productsDetailed: [],
        averageAbsoluteChange: 0,
        averagePercentageChange: 0,
        productsWithChangesCount: 0,
        totalIncreases: 0,
        totalDecreases: 0
      };
    }

    let sumAbsoluteChange = 0;
    let sumPercentageChange = 0;
    let productsWithHistoricalData = 0;
    let totalIncreases = 0;
    let totalDecreases = 0;

    const productsDetailed = suppliedProducts.map(p => {
      const matches = priceEntries.filter(e => e.repId === selectedRepId && e.productId === p.id);
      
      // Sort chronologically by date
      const sortedMatches = [...matches].sort((a, b) => {
        const timeA = a.effectiveDate?.seconds 
          ? a.effectiveDate.seconds * 1000 
          : new Date(a.effectiveDate).getTime() || 0;
        const timeB = b.effectiveDate?.seconds 
          ? b.effectiveDate.seconds * 1000 
          : new Date(b.effectiveDate).getTime() || 0;
        return timeA - timeB;
      });

      const currentPrice = productCurrentPrices[p.id] || 0;
      
      if (sortedMatches.length >= 2) {
        const oldestPrice = sortedMatches[0].price;
        const newestPrice = sortedMatches[sortedMatches.length - 1].price;
        const absoluteChange = newestPrice - oldestPrice;
        const percentageChange = oldestPrice > 0 ? (absoluteChange / oldestPrice) * 100 : 0;

        sumAbsoluteChange += absoluteChange;
        sumPercentageChange += percentageChange;
        productsWithHistoricalData++;

        if (absoluteChange > 0) totalIncreases++;
        if (absoluteChange < 0) totalDecreases++;

        return {
          id: p.id,
          name: p.name,
          sku: p.sku || "N/A",
          category: p.category || "General",
          oldestPrice,
          newestPrice,
          absoluteChange,
          percentageChange,
          hasHistory: true,
          entriesCount: sortedMatches.length
        };
      } else {
        // Only 1 price entry or none
        const singlePrice = sortedMatches[0]?.price || currentPrice;
        return {
          id: p.id,
          name: p.name,
          sku: p.sku || "N/A",
          category: p.category || "General",
          oldestPrice: singlePrice,
          newestPrice: singlePrice,
          absoluteChange: 0,
          percentageChange: 0,
          hasHistory: false,
          entriesCount: sortedMatches.length
        };
      }
    });

    const averageAbsoluteChange = productsWithHistoricalData > 0 
      ? sumAbsoluteChange / productsWithHistoricalData 
      : 0;

    const averagePercentageChange = productsWithHistoricalData > 0 
      ? sumPercentageChange / productsWithHistoricalData 
      : 0;

    return {
      productsDetailed,
      averageAbsoluteChange,
      averagePercentageChange,
      productsWithChangesCount: productsWithHistoricalData,
      totalIncreases,
      totalDecreases
    };
  }, [suppliedProducts, priceEntries, selectedRepId, productCurrentPrices]);

  const handleCreateRepSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newCompany.trim()) return;

    setIsSubmitting(true);
    setProfileError(null);

    try {
      const repRef = doc(collection(db, "reps"));
      const newRep: Rep = {
        id: repRef.id,
        name: newName.trim(),
        company: newCompany.trim(),
        createdAt: serverTimestamp()
      };

      if (newEmail.trim()) newRep.email = newEmail.trim();
      if (newPhone.trim()) newRep.phone = newPhone.trim();
      if (newNotes.trim()) newRep.notes = newNotes.trim();

      await setDoc(repRef, newRep);
      setNewName("");
      setNewCompany("");
      setNewEmail("");
      setNewPhone("");
      setNewNotes("");
      setProfileSuccess(true);
      setTimeout(() => {
        setProfileSuccess(false);
        setShowAddForm(false);
      }, 1500);
      onRepChange();
    } catch (err: any) {
      console.error("Firestore Error creating representative profile:", err);
      let errMsg = "An error occurred while saving the profile. Please check firestore connectivity.";
      if (err instanceof Error) {
        errMsg = err.message;
      } else if (err && typeof err === "object") {
        errMsg = JSON.stringify(err);
      }
      // Make standard Firebase permission errors more user friendly
      if (errMsg.includes("permission") || errMsg.includes("Permission") || errMsg.includes("insufficient")) {
        errMsg = "Permission Denied: Insufficient permissions to create records in Firestore.";
      }
      setProfileError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddVisitLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepId || !visitText.trim()) return;

    try {
      const visitRef = doc(collection(db, "reps", selectedRepId, "visits"));
      const newVisit: Visit = {
        id: visitRef.id,
        repId: selectedRepId,
        visitDate: serverTimestamp(),
        notes: visitText,
        createdAt: serverTimestamp(),
        createdBy: currentUserUid
      };

      await setDoc(visitRef, newVisit);
      setVisitText("");
      setVisitSuccess(true);
      setTimeout(() => setVisitSuccess(false), 2000);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reps/${selectedRepId}/visits`);
    }
  };

  // Pre-populate Low Stock orders
  const handlePrepopulateQtys = () => {
    const qtys: { [pId: string]: number } = {};
    lowStockSuppliedProducts.forEach(p => {
      qtys[p.id] = 5; // Default suggested quantity
    });
    setOrderQtys(prev => ({ ...prev, ...qtys }));
  };

  const handleQtyChange = (prodId: string, value: number) => {
    setOrderQtys(prev => ({
      ...prev,
      [prodId]: value >= 0 ? value : 0
    }));
  };

  // Compiled order total cost
  const draftOrderSummary = useMemo(() => {
    let totals = 0;
    const itemsList: { name: string; qty: number; unitPrice: number; lineCost: number }[] = [];

    Object.entries(orderQtys).forEach(([prodId, qty]) => {
      const q = qty as number;
      if (q <= 0) return;
      const prod = products.find(p => p.id === prodId);
      const price = productCurrentPrices[prodId] || 0.00;
      if (prod) {
        const lineCost = price * q;
        totals += lineCost;
        itemsList.push({
          name: prod.name,
          qty: q,
          unitPrice: price,
          lineCost
        });
      }
    });

    return { totalCost: totals, items: itemsList };
  }, [orderQtys, products, productCurrentPrices]);

  // Export order summary as raw copyable block
  const handleCopyOrderText = () => {
    if (!selectedRep || draftOrderSummary.items.length === 0) return;

    let output = `--- CHAPEL DOWNS SUPERMARKET - PURCHASE ORDER ---\n`;
    output += `Supplier Representative: ${selectedRep.name}\n`;
    output += `Company: ${selectedRep.company}\n`;
    output += `Generated Date: ${new Date().toLocaleDateString()}\n`;
    output += `--------------------------------------------------\n`;

    draftOrderSummary.items.forEach((item, idx) => {
      output += `${idx + 1}. ${item.name} x${item.qty} (Wholesale: $${item.unitPrice.toFixed(2)} ea) - Line total: $${item.lineCost.toFixed(2)}\n`;
    });

    output += `--------------------------------------------------\n`;
    output += `TOTAL ESTIMATED EXPENSE: NZD $${draftOrderSummary.totalCost.toFixed(2)}\n`;
    output += `--------------------------------------------------\n`;
    output += `Prepared for quick review. Please dispatch and process.`;

    navigator.clipboard.writeText(output);
    setCopiedOrder(true);
    setTimeout(() => setCopiedOrder(false), 3000);
  };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3" id="reps_viewport">
      
      {/* SIDESECTION: REP PROFILES SELECTION - COMPACT */}
      <div className="lg:col-span-4 bg-white rounded-md shadow-2xs border border-slate-200 p-3 flex flex-col h-[550px]" id="reps_list">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-xs font-bold text-slate-850">Supplier Representatives</h2>
            <p className="text-[10px] text-slate-400 mt-0.5 leading-none">Chapel Downs partners</p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="p-1 px-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors border border-emerald-150"
          >
            <PlusIcon className="h-3 w-3" />
            <span>New Rep</span>
          </button>
        </div>

        {showAddForm ? (
          <form onSubmit={handleCreateRepSubmit} className="space-y-2 bg-slate-50 border border-slate-200 rounded p-2.5 text-left">
            <h3 className="text-[10px] font-bold text-slate-700">Add Supplier Rep Profile</h3>

            {profileError && (
              <div className="p-2 bg-rose-50 text-rose-800 border border-rose-150 rounded text-[9px] flex items-center gap-1.5 leading-snug">
                <AlertCircleIcon className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                <span className="font-semibold">{profileError}</span>
              </div>
            )}
            
            <div className="space-y-0.5">
              <label className="text-[8px] uppercase font-bold text-slate-400">Rep Name</label>
              <input 
                type="text" required
                disabled={isSubmitting}
                className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-sans disabled:opacity-50"
                placeholder="e.g. Liam Henderson"
                value={newName} onChange={(e) => setNewName(e.target.value)}
              />
            </div>

            <div className="space-y-0.5">
              <label className="text-[8px] uppercase font-bold text-slate-400">Company Supplier</label>
              <input 
                type="text" required
                disabled={isSubmitting}
                className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-sans disabled:opacity-50"
                placeholder="e.g. Goodman Fielder"
                value={newCompany} onChange={(e) => setNewCompany(e.target.value)}
              />
            </div>

            <div className="space-y-0.5">
              <label className="text-[8px] uppercase font-bold text-slate-400">Contact Email</label>
              <input 
                type="email"
                disabled={isSubmitting}
                className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-mono disabled:opacity-50"
                placeholder="liam@goodman.co.nz"
                value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>

            <div className="space-y-0.5">
              <label className="text-[8px] uppercase font-bold text-slate-400">Contact Mobile</label>
              <input 
                type="text"
                disabled={isSubmitting}
                className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-mono disabled:opacity-50"
                placeholder="e.g. +64 21 000 000"
                value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>

            <div className="space-y-0.5">
              <label className="text-[8px] uppercase font-bold text-slate-400">Representative Notes</label>
              <textarea 
                rows={2}
                disabled={isSubmitting}
                className="w-full text-[10px] p-1 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-sans disabled:opacity-50"
                placeholder="Minimum order $250, visits Tuesdays..."
                value={newNotes} onChange={(e) => setNewNotes(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-1.5 pt-1">
              <button 
                type="button" 
                disabled={isSubmitting}
                onClick={() => {
                  setProfileError(null);
                  setShowAddForm(false);
                }}
                className="text-[9px] uppercase font-bold text-slate-400 px-1.5 py-1 cursor-pointer disabled:opacity-40"
              >
                Cancel
              </button>
              <button 
                type="submit"
                disabled={isSubmitting}
                className="bg-emerald-700 hover:bg-emerald-800 text-white text-[9px] uppercase font-bold px-2 py-1 rounded cursor-pointer disabled:opacity-50 flex items-center gap-1"
              >
                {isSubmitting && <LoaderIcon className="h-3 w-3 animate-spin text-white" />}
                <span>{profileSuccess ? "Saved!" : isSubmitting ? "Saving..." : "Save Profile"}</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1 pr-1" id="reps_profiles_directory">
            {reps.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-slate-400">No supermarket reps created yet.</div>
            ) : (
              reps.map(r => (
                <div
                  key={r.id}
                  onClick={() => setSelectedRepId(r.id)}
                  className={`p-2 rounded border text-left cursor-pointer transition-all ${
                    selectedRepId === r.id 
                      ? "border-emerald-650 bg-emerald-55/30" 
                      : "border-slate-100 hover:border-slate-250 hover:bg-slate-50/50"
                  }`}
                >
                  <p className="text-[8px] font-mono text-slate-400 uppercase tracking-tight">{r.company}</p>
                  <h3 className="text-[11px] font-bold text-slate-800 mt-0.5">{r.name}</h3>
                  <div className="flex items-center gap-1.5 mt-1 text-[9px] text-slate-500">
                    <PhoneIcon className="h-3 w-3 text-slate-400" />
                    <span>{r.phone || "No phone listed"}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* CORE VIEWPORT: REPS MANAGEMENT DETAILS AND VISIT NOTES */}
      <div className="lg:col-span-8 space-y-3" id="reps_viewport_details">
        {selectedRep ? (
          <div className="bg-white rounded-md shadow-2xs border border-slate-200 p-4 space-y-4 text-left" id="rep_profile_interactive">
            
            {/* PROFILE CARD */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-150">
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] uppercase font-bold tracking-wider text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded">{selectedRep.company} Representative</span>
                  <button
                    onClick={() => setShowPrintReport(true)}
                    className="p-1 px-2 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded text-[9px] font-bold flex items-center gap-1 cursor-pointer transition-colors border border-slate-200"
                    title="Generate printer-friendly brief for upcoming rep reviews"
                  >
                    <PrinterIcon className="h-3 w-3 text-slate-500" />
                    <span>Generate Prep Report</span>
                  </button>
                </div>
                <h1 className="text-base font-bold text-slate-900 mt-0.5">{selectedRep.name}</h1>
                <div className="flex flex-wrap items-center gap-2.5 pt-0.5 text-[10px] text-slate-600">
                  <span className="flex items-center gap-1">
                    <MailIcon className="h-3 w-3 text-slate-400" />
                    <a href={`mailto:${selectedRep.email}`} className="hover:underline font-mono">{selectedRep.email || "No email"}</a>
                  </span>
                  <span className="flex items-center gap-1">
                    <PhoneIcon className="h-3 w-3 text-slate-400" />
                    <a href={`tel:${selectedRep.phone}`} className="hover:underline font-mono">{selectedRep.phone || "No phone"}</a>
                  </span>
                </div>
              </div>

              {/* TELEMETRY STATS EXPENSE - COMPACT ROW */}
              <div className="p-2 bg-emerald-50/40 border border-emerald-100 rounded flex gap-3 shrink-0 text-[10px]">
                <div className="text-left">
                  <p className="text-[8px] uppercase font-bold text-slate-400 flex items-center gap-0.5 leading-none">
                    <CalcIcon className="h-2.5 w-2.5" />
                    <span>Spent (7d)</span>
                  </p>
                  <p className="text-xs font-extrabold text-emerald-800 mt-0.5">${weeklyExpenseSummary.currentWeekTotal.toFixed(2)}</p>
                </div>
                <div className="border-l border-emerald-150 pl-3 text-left">
                  <p className="text-[8px] uppercase font-bold text-slate-400 leading-none">Total Spent</p>
                  <p className="text-xs font-extrabold text-slate-800 mt-0.5">${weeklyExpenseSummary.lifetimeSpent.toFixed(2)}</p>
                </div>
              </div>
            </div>

            {selectedRep.notes && (
              <p className="text-[11px] text-slate-500 italic bg-slate-50 p-2.5 rounded border border-slate-150 leading-relaxed">
                Profile Memo: {selectedRep.notes}
              </p>
            )}

            {/* TAB SECTION: DRAFT ORDERING ENGINE AND HISTORY SCANS */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              
              {/* VISIT DIARY & LOGS PORTAL - COMPACT */}
              <div className="space-y-2.5">
                <h3 className="text-[11px] font-bold text-slate-750 flex items-center gap-1">
                  <CalendarIcon className="h-3.5 w-3.5 text-emerald-600" />
                  <span>Visit Diary &amp; Memo Comments</span>
                </h3>

                {/* ADD DIARY FORM */}
                <form onSubmit={handleAddVisitLog} className="space-y-2 p-2.5 bg-slate-50 rounded border border-slate-150">
                  <p className="text-[9px] text-slate-400 leading-tight">Log credit notes, delivery delays, or wholesale price agreements.</p>
                  <textarea
                    rows={2} required
                    className="w-full text-[10px] p-1.5 bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-500 font-sans"
                    placeholder="e.g. Promised credit of $50 next invoice for spoiled units..."
                    value={visitText} onChange={(e) => setVisitText(e.target.value)}
                  />
                  <div className="flex justify-between items-center">
                    {visitSuccess ? (
                      <span className="text-[9px] text-emerald-700 font-semibold flex items-center gap-0.5">
                        <CheckIcon className="h-3 w-3" /> Saved Note
                      </span>
                    ) : (
                      <div></div>
                    )}
                    <button
                      type="submit"
                      className="px-2 py-0.5 bg-slate-900 hover:bg-slate-850 text-white text-[9px] font-semibold rounded cursor-pointer transition-all"
                    >
                      Log Entry
                    </button>
                  </div>
                </form>

                {/* VISITS DIRECTORY LIST */}
                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1" id="diary_logs_scroll">
                  {repVisits.length === 0 ? (
                    <p className="text-[10px] text-slate-400 py-3 text-center italic">No diary notes logged yet.</p>
                  ) : (
                    repVisits.map(v => (
                      <div key={v.id} className="p-2 bg-white border border-slate-150 rounded text-[10px] space-y-1">
                        <p className="text-slate-700 leading-snug">{v.notes}</p>
                        <p className="text-[8px] text-slate-400 font-mono">Logged: {new Date(v.createdAt?.seconds ? v.createdAt.seconds * 1000 : v.createdAt).toLocaleDateString()}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* DRAFT ORDER LIST EXPORTER PRE-VISIT */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-1">
                  <h3 className="text-[11px] font-bold text-slate-755 flex items-center gap-1">
                    <SheetIcon className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Purchase Order Draft</span>
                  </h3>
                  {lowStockSuppliedProducts.length > 0 && (
                    <button
                      onClick={handlePrepopulateQtys}
                      className="text-[8px] font-bold text-emerald-850 hover:text-emerald-950 bg-emerald-50 hover:bg-emerald-100 p-1 rounded transition-colors cursor-pointer border border-emerald-150"
                    >
                      Load Low Stock
                    </button>
                  )}
                </div>

                <p className="text-[9px] text-slate-500 leading-tight">
                  Draft order requirements before the rep visits Chapel Downs supermarket. Low-stock lines can be auto-loaded.
                </p>

                {/* LIST SUPPLIED PRODUCTS */}
                {suppliedProducts.length === 0 ? (
                  <p className="text-[10px] text-slate-405 py-4 text-center italic border border-dashed rounded">No items mapped. Scan invoices first.</p>
                ) : (
                  <div className="space-y-2" id="rep_order_builder">
                    <div className="max-h-40 overflow-y-auto pr-1 space-y-1 bg-slate-50/50 p-1.5 rounded border border-slate-150" id="scroll_order_products">
                      {suppliedProducts.map(p => {
                        const cost = productCurrentPrices[p.id] || 0;
                        const isLow = p.lowStock;
                        return (
                          <div key={p.id} className="flex items-center justify-between p-1 hover:bg-white rounded text-[10px] border border-transparent hover:border-slate-150/50">
                            <div className="space-y-0.5 text-left max-w-[140px]">
                              <p className="font-semibold text-slate-800 line-clamp-1 leading-none">{p.name}</p>
                              <div className="flex items-center gap-1 text-[8px] leading-none">
                                <span className="text-slate-400 font-mono">Unit: ${cost.toFixed(2)}</span>
                                {isLow && (
                                  <span className="font-bold text-amber-700 bg-amber-50 px-0.5 rounded text-[7px]" title="Out of stock trigger">
                                    LOW
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-[8px] text-slate-400 font-bold">Qty:</span>
                              <input
                                type="number"
                                className="w-10 p-0.5 border border-slate-200 text-[10px] rounded text-center focus:outline-none focus:ring-1 focus:ring-emerald-500 font-bold bg-white"
                                min="0"
                                value={orderQtys[p.id] || 0}
                                onChange={(e) => handleQtyChange(p.id, parseInt(e.target.value) || 0)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* ORDER EST TOTAL & CLIPBOARD ACTIONS */}
                    {draftOrderSummary.items.length > 0 && (
                      <div className="p-2 bg-slate-50 border border-slate-150 rounded space-y-2 text-[10px]" id="draft_order_summary_card">
                        <div className="flex justify-between items-baseline">
                          <span className="font-bold text-slate-500">Est. Wholesale Total:</span>
                          <span className="text-xs font-extrabold text-emerald-800">${draftOrderSummary.totalCost.toFixed(2)}</span>
                        </div>
                        <button
                          onClick={handleCopyOrderText}
                          type="button"
                          className="w-full py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-semibold rounded flex items-center justify-center gap-1 cursor-pointer transition-colors"
                        >
                          {copiedOrder ? (
                            <>
                              <CheckIcon className="h-3 w-3" />
                              <span>Copied draft Po!</span>
                            </>
                          ) : (
                            <>
                              <CopyIcon className="h-3 w-3" />
                              <span>Copy Purchase Order</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}

                  </div>
                )}
              </div>

            </div>

          </div>
        ) : (
          <div className="bg-white rounded-md shadow-2xs border border-slate-200 p-12 text-center text-slate-400 flex flex-col items-center justify-center h-[550px]" id="reps_empty_view">
            <UsersIcon className="h-8 w-8 text-slate-300 mb-2" />
            <h3 className="text-xs font-bold text-slate-750 font-sans">Representative Profiles</h3>
            <p className="text-[10px] text-slate-405 mt-1 max-w-xs leading-normal">
              Select or configure an independent representative profile on the sidebar to review visit diaries, write credit comments, compile draft purchase order exports, or review spend histories.
            </p>
          </div>
        )}
      </div>

    </div>

    {showPrintReport && selectedRep && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto no-print-backdrop">
        <div className="bg-white rounded-lg shadow-2xl border border-slate-200 w-full max-w-4xl p-6 relative max-h-[90vh] overflow-y-auto flex flex-col">
          
          {/* Modal Actions - Hidden on actual print via standard print rules or CSS */}
          <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4 no-print">
            <div className="flex items-center gap-2">
              <PrinterIcon className="h-4 w-4 text-emerald-850" />
              <h2 className="text-xs font-extrabold text-slate-800 uppercase tracking-wider">Report Preview</h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => window.print()}
                className="p-1.5 px-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-[11px] font-bold flex items-center gap-1.5 hover:shadow-xs transition-all cursor-pointer"
              >
                <PrinterIcon className="h-3.5 w-3.5" />
                <span>Print Report</span>
              </button>
              <button
                onClick={() => setShowPrintReport(false)}
                className="p-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-bold transition-all cursor-pointer border border-slate-250"
              >
                Close Preview
              </button>
            </div>
          </div>

          {/* Printable Area starts here */}
          <div id="printable-report-area" className="flex-1 bg-white text-slate-900 p-8 pt-4 rounded border border-slate-200 font-sans">
            
            {/* CSS for printing */}
            <style>{`
              @media print {
                body * {
                  visibility: hidden !important;
                }
                #printable-report-area, #printable-report-area * {
                  visibility: visible !important;
                }
                #printable-report-area {
                  position: absolute !important;
                  left: 0 !important;
                  top: 0 !important;
                  width: 100% !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  border: none !important;
                  box-shadow: none !important;
                  background: white !important;
                  color: black !important;
                }
                .no-print {
                  display: none !important;
                }
                .print-break-inside-avoid {
                  page-break-inside: avoid !important;
                }
              }
            `}</style>

            {/* Brand Header */}
            <div className="border-b-4 border-emerald-850 pb-3 mb-6 flex items-center justify-between">
              <div className="text-left">
                <h1 className="text-lg font-black text-emerald-850 tracking-wider">CHAPEL DOWNS SUPERMARKET</h1>
                <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold mt-0.5">Procurement &amp; Supplier Management Systems</p>
              </div>
              <div className="text-right">
                <span className="text-[9px] uppercase font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">Supplier Briefing Dossier</span>
                <p className="text-[8px] font-mono text-slate-405 mt-1">Generated: {new Date().toLocaleString()}</p>
              </div>
            </div>

            {/* Report Main Title */}
            <div className="mb-6 bg-slate-50 border-l-4 border-emerald-600 p-4 rounded text-left">
              <h2 className="text-[11px] text-emerald-850 uppercase font-extrabold tracking-wider">Representative Briefing Summary</h2>
              <h1 className="text-lg font-black text-slate-950 mt-0.5">{selectedRep.name}</h1>
              <p className="text-[10px] text-slate-600 mt-1">
                This workspace briefing prepares supermarket managers for oncoming supplier review panels, credit negotiations, and price audits with representatives from <strong className="font-bold">{selectedRep.company}</strong>.
              </p>
            </div>

            {/* Section 1: Contact Details & Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              
              {/* Card: Profile & Contact Details */}
              <div className="border border-slate-200 rounded p-4 text-left">
                <h3 className="text-[10px] uppercase font-bold tracking-wider text-slate-500 border-b border-slate-150 pb-1 mb-2.5">Representative Profile Info</h3>
                <div className="space-y-2 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-semibold">Rep Name:</span>
                    <span className="text-slate-800 font-bold">{selectedRep.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-semibold">Company / Supplier:</span>
                    <span className="text-slate-800 font-bold">{selectedRep.company}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-semibold">Phone:</span>
                    <span className="text-slate-800 font-mono font-bold">{selectedRep.phone || "Not Listed"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-semibold">Email:</span>
                    <span className="text-slate-800 font-mono hover:underline">{selectedRep.email || "Not Listed"}</span>
                  </div>
                  {selectedRep.notes && (
                    <div className="pt-2 border-t border-slate-100 mt-2">
                      <span className="text-slate-400 font-semibold text-[10px] uppercase block mb-1">Internal Office Notes:</span>
                      <p className="text-[10px] text-slate-600 italic leading-normal bg-slate-50 p-2 rounded">{selectedRep.notes}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Card: Portfolio Summary Analytics */}
              <div className="border border-slate-200 rounded p-4 text-left">
                <h3 className="text-[10px] uppercase font-bold tracking-wider text-slate-500 border-b border-slate-150 pb-1 mb-2.5">Supplier Portfolio Analytics</h3>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className="bg-slate-50 p-2.5 rounded text-left">
                    <span className="text-[8px] uppercase font-semibold text-slate-400 block tracking-wider">Total Items Supplied</span>
                    <span className="text-lg font-black text-slate-850 mt-0.5 block">{suppliedProducts.length}</span>
                  </div>
                  <div className="bg-slate-50 p-2.5 rounded text-left">
                    <span className="text-[8px] uppercase font-semibold text-slate-400 block tracking-wider">Average Price Shift</span>
                    <span className={`text-base font-black mt-0.5 block ${
                      costChangeMetrics.averageAbsoluteChange > 0 
                        ? "text-rose-700" 
                        : costChangeMetrics.averageAbsoluteChange < 0 
                          ? "text-emerald-700" 
                          : "text-slate-700"
                    }`}>
                      {costChangeMetrics.averageAbsoluteChange > 0 ? "+" : ""}
                      ${costChangeMetrics.averageAbsoluteChange.toFixed(2)} ({costChangeMetrics.averagePercentageChange.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Products Monitored:</span>
                    <span className="text-slate-850 font-semibold">{costChangeMetrics.productsDetailed.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Lines with changes:</span>
                    <span className="text-slate-850 font-semibold">{costChangeMetrics.productsWithChangesCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Recent 7-Day Spend:</span>
                    <span className="text-emerald-700 font-extrabold">${weeklyExpenseSummary.currentWeekTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total Lifetime Spent:</span>
                    <span className="text-slate-850 font-extrabold">${weeklyExpenseSummary.lifetimeSpent.toFixed(2)}</span>
                  </div>
                </div>
              </div>

            </div>

            {/* Section 2: Visit Notes History */}
            <div className="mb-6 text-left print-break-inside-avoid">
              <h3 className="text-[10px] uppercase font-bold tracking-wider text-slate-500 border-b border-slate-150 pb-1 mb-2.5">Logged Visit Notes &amp; Meeting Diaries</h3>
              {repVisits.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic py-3 text-center border border-dashed rounded bg-slate-50/50">
                  No historical office records or visit diaries registered for this representative.
                </p>
              ) : (
                <div className="border border-slate-200 rounded divide-y divide-slate-150 bg-white">
                  {repVisits.map((visit, index) => (
                    <div key={visit.id} className="p-3 text-[10px] space-y-1 hover:bg-slate-50/40">
                      <div className="flex justify-between items-center text-slate-400 font-semibold mb-1">
                        <span>VISIT LOG #{repVisits.length - index}</span>
                        <span className="font-mono">{new Date(visit.createdAt?.seconds ? visit.createdAt.seconds * 1000 : visit.createdAt).toLocaleDateString()}</span>
                      </div>
                      <p className="text-slate-700 leading-relaxed font-sans">{visit.notes}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Section 3: Product Cost Changes Table */}
            <div className="text-left print-break-inside-avoid">
              <h3 className="text-[10px] uppercase font-bold tracking-wider text-slate-500 border-b border-slate-150 pb-1 mb-2.5">Wholesale Cost Changes &amp; Trends</h3>
              {suppliedProducts.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic py-4 text-center border border-dashed rounded bg-slate-50/50">
                  No product items are mapped to this representative. Compile invoices or prices first.
                </p>
              ) : (
                <div className="border border-slate-200 rounded overflow-hidden">
                  <table className="w-full text-left text-[10px] border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-bold uppercase text-[8px] text-slate-500 tracking-wider">
                        <th className="p-2.5 pl-3">Product Description</th>
                        <th className="p-2.5 text-center">Category</th>
                        <th className="p-2.5 text-right font-mono">Original Cost</th>
                        <th className="p-2.5 text-right font-mono">Current Cost</th>
                        <th className="p-2.5 text-right font-mono">Net Shift</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150">
                      {costChangeMetrics.productsDetailed.map(item => {
                        const absChange = item.absoluteChange;
                        const percentChange = item.percentageChange;
                        return (
                          <tr key={item.id} className="hover:bg-slate-50/40">
                            <td className="p-2.5 pl-3">
                              <p className="font-bold text-slate-800">{item.name}</p>
                              <p className="text-[8px] text-slate-400 font-mono mt-0.5">ID: {item.id}</p>
                            </td>
                            <td className="p-2.5 text-slate-500 text-center">{item.category}</td>
                            <td className="p-2.5 text-right font-mono font-medium">${item.oldestPrice.toFixed(2)}</td>
                            <td className="p-2.5 text-right font-mono font-bold text-slate-800">${item.newestPrice.toFixed(2)}</td>
                            <td className="p-2.5 text-right font-mono">
                              {item.hasHistory ? (
                                <span className={`font-bold rounded-sm px-1 py-0.5 inline-block text-[8px] ${
                                  absChange > 0 
                                    ? "bg-rose-50 text-rose-700 border border-rose-100" 
                                    : absChange < 0 
                                      ? "bg-emerald-50 text-emerald-700 border border-emerald-100" 
                                      : "text-slate-500"
                                }`}>
                                  {absChange > 0 ? "+" : ""}
                                  ${absChange.toFixed(2)} ({percentChange.toFixed(1)}%)
                                </span>
                              ) : (
                                <span className="text-slate-400 italic">No history</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="bg-slate-50 p-2.5 px-3 border-t border-slate-200 text-[9px] text-slate-500 flex justify-between font-semibold">
                    <span>Calculated over {costChangeMetrics.productsWithChangesCount} lines with cost trajectory tracking.</span>
                    <span className="font-bold uppercase tracking-wider text-slate-600">Total lines: {suppliedProducts.length}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Auditor Closing Memo signature block */}
            <div className="mt-8 border-t border-dashed border-slate-250 pt-6 flex justify-between items-end print-break-inside-avoid">
              <div className="text-left leading-normal text-[9px] text-slate-400">
                <p className="font-bold uppercase text-slate-500">MEMBER DISCLOSURE NOTES</p>
                <p className="max-w-md mt-1">
                  Chapel Downs Supermarket Procurement Portal. All calculated price changes, spend metrics, and historical logs are sourced dynamically from real-time database inputs. Please handle with confidentiality.
                </p>
              </div>
              <div className="text-right w-44">
                <div className="border-b border-slate-300 h-8"></div>
                <p className="text-[8px] uppercase tracking-wider text-slate-450 mt-1 font-bold">Manager Signature / Approval</p>
              </div>
            </div>

          </div>
        </div>
      </div>
    )}
    </>
  );
}
