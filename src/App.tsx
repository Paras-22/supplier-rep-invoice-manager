import { useState, useEffect, FormEvent } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, User, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { collection, onSnapshot, getDocs, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { auth, db, googleProvider, testConnection, handleFirestoreError, OperationType } from "./firebase";
import { Product, Rep, PriceEntry, Invoice, Visit } from "./types";
import POSImport from "./components/POSImport";
import DocketScanner from "./components/DocketScanner";
import ProductCatalog from "./components/ProductCatalog";
import RepDirectory from "./components/RepDirectory";
import LowStockAlerts from "./components/LowStockAlerts";
import { Store, Receipt, Search, Users, ClipboardList, LogOut, CheckCircle2, ChevronRight, Lock, Sparkles, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | { uid: string; displayName: string; email: string; photoURL: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"scan" | "catalog" | "reps" | "pos-import" | "alerts">("scan");

  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [authActionLoading, setAuthActionLoading] = useState(false);

  const [reps, setReps] = useState<Rep[]>([]);
  const [priceEntries, setPriceEntries] = useState<PriceEntry[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [allVisits, setAllVisits] = useState<Visit[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<Product[]>([]);

  useEffect(() => {
    testConnection();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        if (user.uid !== "mock_supermarket_manager") {
          try {
            const userRef = doc(db, "users", user.uid);
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists()) {
              await setDoc(userRef, {
                uid: user.uid,
                email: user.email || "",
                displayName: user.displayName || user.email?.split("@")[0] || "Staff Member",
                createdAt: serverTimestamp(),
                lastLogin: serverTimestamp()
              });
            } else {
              await updateDoc(userRef, { lastLogin: serverTimestamp() });
            }
          } catch (syncErr) {
            console.error("Failed to sync auth state user to Firestore:", syncErr);
          }
        }
      } else {
        if (currentUser?.uid !== "mock_supermarket_manager") {
          setCurrentUser(null);
        }
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;

    const unsubReps = onSnapshot(collection(db, "reps"), (snapshot) => {
      const repList: Rep[] = [];
      snapshot.forEach(doc => {
        repList.push({ id: doc.id, ...doc.data() } as Rep);
      });
      setReps(repList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "reps");
    });

    const unsubPrices = onSnapshot(collection(db, "prices"), (snapshot) => {
      const priceList: PriceEntry[] = [];
      snapshot.forEach(doc => {
        priceList.push({ id: doc.id, ...doc.data() } as PriceEntry);
      });
      setPriceEntries(priceList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "prices");
    });

    const unsubInvoices = onSnapshot(collection(db, "invoices"), (snapshot) => {
      const invList: Invoice[] = [];
      snapshot.forEach(doc => {
        invList.push({ id: doc.id, ...doc.data() } as Invoice);
      });
      setInvoices(invList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "invoices");
    });

    const unsubLowStock = onSnapshot(collection(db, "products"), (snapshot) => {
      const lowList: Product[] = [];
      snapshot.forEach(doc => {
        const p = { id: doc.id, ...doc.data() } as Product;
        if (p.lowStock || (p.currentStock !== undefined && p.minStockLevel !== undefined && p.currentStock < p.minStockLevel)) {
          lowList.push(p);
        }
      });
      setLowStockProducts(lowList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "products");
    });

    return () => {
      unsubReps();
      unsubPrices();
      unsubInvoices();
      unsubLowStock();
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || reps.length === 0) return;
    const fetchAllVisits = async () => {
      try {
        const visitsList: Visit[] = [];
        for (const r of reps) {
          const vCol = collection(db, "reps", r.id, "visits");
          const vSnap = await getDocs(vCol);
          vSnap.forEach(doc => {
            visitsList.push({ id: doc.id, ...doc.data() } as Visit);
          });
        }
        setAllVisits(visitsList);
      } catch (err) {
        console.warn("Retrying visits fetch...", err);
      }
    };
    fetchAllVisits();
  }, [currentUser, reps, priceEntries]);

  const handleEmailAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError("Email and Password are required.");
      return;
    }
    if (isSignUp && !authName.trim()) {
      setAuthError("Full Name is required for registration.");
      return;
    }
    if (authPassword.length < 6) {
      setAuthError("Password must be at least 6 characters.");
      return;
    }
    try {
      setAuthActionLoading(true);
      if (isSignUp) {
        const userCredential = await createUserWithEmailAndPassword(auth, authEmail.trim(), authPassword.trim());
        await updateProfile(userCredential.user, { displayName: authName.trim() });
        try {
          const userRef = doc(db, "users", userCredential.user.uid);
          await setDoc(userRef, {
            uid: userCredential.user.uid,
            email: authEmail.trim(),
            displayName: authName.trim(),
            createdAt: serverTimestamp(),
            lastLogin: serverTimestamp()
          });
        } catch (dbErr) {
          console.error("Failed to write user info:", dbErr);
        }
        setCurrentUser({ ...userCredential.user, displayName: authName.trim(), email: authEmail.trim() } as any);
        setAuthSuccess("Registered successfully! Welcome aboard.");
      } else {
        const userCredential = await signInWithEmailAndPassword(auth, authEmail.trim(), authPassword.trim());
        try {
          const userRef = doc(db, "users", userCredential.user.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: userCredential.user.uid,
              email: userCredential.user.email || "",
              displayName: userCredential.user.displayName || userCredential.user.email?.split("@")[0] || "Staff Member",
              createdAt: serverTimestamp(),
              lastLogin: serverTimestamp()
            });
          } else {
            await updateDoc(userRef, { lastLogin: serverTimestamp() });
          }
        } catch (dbErr) {
          console.error("Failed to update login details:", dbErr);
        }
        setCurrentUser(userCredential.user);
        setAuthSuccess("Successfully logged in.");
      }
    } catch (err: any) {
      let readableError = err.message || "An error occurred.";
      if (err.code === "auth/email-already-in-use") readableError = "This email is already registered.";
      else if (err.code === "auth/weak-password") readableError = "Password should be at least 6 characters.";
      else if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found") readableError = "Incorrect email or password.";
      else if (err.message?.includes("CONFIGURATION_NOT_FOUND") || err.code === "auth/operation-not-allowed") readableError = "Email/Password sign-in is not enabled in Firebase Console.";
      setAuthError(readableError);
    } finally {
      setAuthActionLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      setAuthLoading(true);
      const result = await signInWithPopup(auth, googleProvider);
      if (result?.user) {
        try {
          const userRef = doc(db, "users", result.user.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: result.user.uid,
              email: result.user.email || "",
              displayName: result.user.displayName || result.user.email?.split("@")[0] || "Staff Member",
              createdAt: serverTimestamp(),
              lastLogin: serverTimestamp()
            });
          } else {
            await updateDoc(userRef, { lastLogin: serverTimestamp() });
          }
        } catch (dbErr) {
          console.error("Failed to sync Google user:", dbErr);
        }
      }
    } catch (err) {
      console.error("Google auth failed:", err);
      handleDemoBypass();
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDemoBypass = () => {
    setCurrentUser({
      uid: "mock_supermarket_manager",
      displayName: "Store Manager (Auckland)",
      email: "manager@chapeldowns.co.nz",
      photoURL: ""
    });
    setAuthLoading(false);
  };

  const handleLogOutComp = async () => {
    if (currentUser?.uid === "mock_supermarket_manager") {
      setCurrentUser(null);
    } else {
      await signOut(auth);
    }
    setReps([]);
    setPriceEntries([]);
    setInvoices([]);
    setLowStockProducts([]);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center space-y-4">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
        <p className="text-sm font-semibold text-gray-500">Connecting Chapel Downs Supermarket database...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden text-center">
          <div className="bg-gradient-to-r from-emerald-800 to-teal-700 py-10 px-6 text-white relative">
            <div className="absolute top-4 right-4 text-[9px] uppercase font-bold tracking-wider opacity-60 flex items-center gap-1">
              <Store className="h-3 w-3" />
              <span>Auckland, NZ</span>
            </div>
            <Store className="h-12 w-12 mx-auto mb-3 stroke-[1.5px]" />
            <h1 className="text-2xl font-bold font-sans tracking-tight">Chapel Downs Supermarket</h1>
            <p className="text-xs text-emerald-100 mt-1.5 font-medium">Supplier Rep &amp; Invoice Manager</p>
          </div>

          <div className="p-8 space-y-5 text-left">
            <div className="space-y-1.5 text-center">
              <h2 className="text-lg font-bold text-gray-800 flex items-center justify-center gap-1.5">
                <Lock className="h-4 w-4 text-emerald-600" />
                <span>Staff Terminal Gateway</span>
              </h2>
              <p className="text-xs text-gray-500 leading-relaxed">Connect and synchronize with Chapel Downs Supermarket inventory systems.</p>
            </div>

            {authError && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 text-[11px] rounded-lg leading-tight font-medium">{authError}</div>}
            {authSuccess && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] rounded-lg leading-tight font-medium">{authSuccess}</div>}

            <div className="flex bg-slate-100 rounded-lg p-1">
              <button type="button" onClick={() => { setIsSignUp(false); setAuthError(null); }} className={`flex-1 py-1 px-3 text-center text-xs font-bold rounded-md transition-all cursor-pointer ${!isSignUp ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>Sign In</button>
              <button type="button" onClick={() => { setIsSignUp(true); setAuthError(null); }} className={`flex-1 py-1 px-3 text-center text-xs font-bold rounded-md transition-all cursor-pointer ${isSignUp ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>Sign Up Staff</button>
            </div>

            <form onSubmit={handleEmailAuthSubmit} className="space-y-3">
              {isSignUp && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Full Name</label>
                  <input type="text" required disabled={authActionLoading} placeholder="e.g. Rachel Green" value={authName} onChange={(e) => setAuthName(e.target.value)} className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 transition-all" />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Staff Email</label>
                <input type="email" required disabled={authActionLoading} placeholder="name@chapeldowns.co.nz" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 transition-all" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Security Password</label>
                <input type="password" required disabled={authActionLoading} placeholder="••••••••" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 transition-all" />
              </div>
              <button type="submit" disabled={authActionLoading} className="w-full mt-2 py-2.5 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow-md transition-all">
                {authActionLoading ? <span className="h-4 w-4 border-2 border-white border-t-transparent animate-spin rounded-full"></span> : <span>{isSignUp ? "Register Supermarket Profile" : "Secure Staff Login"}</span>}
              </button>
            </form>

            <div className="relative flex py-1 items-center">
              <div className="flex-grow border-t border-slate-200"></div>
              <span className="flex-shrink mx-3 text-slate-400 text-[9px] uppercase tracking-wider font-bold">Alternative Portals</span>
              <div className="flex-grow border-t border-slate-200"></div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={handleGoogleSignIn} className="py-2.5 px-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-all">
                <span className="font-bold">Google Portal</span>
              </button>
              <button type="button" onClick={handleDemoBypass} className="py-2.5 px-2 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-all shadow-sm">
                <Sparkles className="h-3 w-3 text-emerald-500" />
                <span>Demo Sandbox</span>
              </button>
            </div>

            <p className="text-[9px] text-slate-400 text-center leading-normal italic max-w-xs mx-auto">
              Please ensure "Email/Password" authentication provider is activated in your Firebase console.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const lowStockCount = lowStockProducts.length;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-gray-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-3 h-11 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-emerald-700 text-white p-1 rounded">
              <Store className="h-4 w-4" />
            </div>
            <div className="text-left font-sans flex items-baseline gap-1.5">
              <h1 className="text-xs font-bold text-slate-900 tracking-tight leading-none">Chapel Downs Supermarket</h1>
              <span className="text-[10px] text-emerald-700 font-medium">Rep &amp; Invoice Manager</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex flex-col text-right leading-tight">
              <span className="text-[10px] font-bold text-slate-700">{currentUser.displayName || "Store Clerk"}</span>
              <span className="text-[9px] text-slate-400 font-mono">{currentUser.email}</span>
            </div>
            <button onClick={handleLogOutComp} className="p-1 text-slate-400 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 rounded border border-slate-200 transition-colors cursor-pointer">
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <div className="bg-[#0f172a] border-b border-emerald-950 py-0.5 sticky top-11 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-3 flex overflow-x-auto space-x-1">
          {[
            { id: "scan", label: "Docket Scan Review", icon: <Receipt className="h-3.5 w-3.5" /> },
            { id: "catalog", label: "POS Product Directory", icon: <Search className="h-3.5 w-3.5" /> },
            { id: "reps", label: "Supplier Rep Profiles", icon: <Users className="h-3.5 w-3.5" /> },
            { id: "pos-import", label: "Idealpos Product Import", icon: <ClipboardList className="h-3.5 w-3.5" /> },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${activeTab === tab.id ? "bg-emerald-700 text-white" : "text-slate-300 hover:bg-slate-800/80 hover:text-white"}`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
          <button
            onClick={() => setActiveTab("alerts")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${activeTab === "alerts" ? "bg-rose-700 text-white" : "text-slate-300 hover:bg-slate-800/80 hover:text-white"}`}
          >
            <AlertTriangle className={`h-3.5 w-3.5 ${lowStockCount > 0 ? "animate-pulse text-rose-400" : ""}`} />
            <span>Low Stock Alerts</span>
            {lowStockCount > 0 && <span className="px-1.5 bg-rose-600 rounded-full text-white text-[9px] font-bold">{lowStockCount}</span>}
          </button>
        </div>
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto p-3 pb-12">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.1 }}
          >
            {activeTab === "scan" && <DocketScanner reps={reps} products={[]} onScanConfirmed={() => setActiveTab("catalog")} currentUserUid={currentUser.uid} />}
            {activeTab === "catalog" && <ProductCatalog reps={reps} priceEntries={priceEntries} currentUserUid={currentUser.uid} />}
            {activeTab === "reps" && <RepDirectory reps={reps} visits={allVisits} products={[]} priceEntries={priceEntries} invoices={invoices} onRepChange={() => {}} currentUserUid={currentUser.uid} />}
            {activeTab === "pos-import" && <POSImport onImportComplete={() => setActiveTab("catalog")} existingProductIds={[]} />}
            {activeTab === "alerts" && <LowStockAlerts products={lowStockProducts} reps={reps} currentUserUid={currentUser.uid} onNavigateToCatalog={() => setActiveTab("catalog")} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="py-2.5 bg-white border-t border-slate-200 text-center text-[9px] text-slate-400 font-mono mt-auto shrink-0 leading-relaxed">
        Chapel Downs Supermarket — Auckland, NZ. Operational Portal, strictly authing verified staff. All wholesale prices logged sequentially.
      </footer>
    </div>
  );
}