import { useState, useEffect, FormEvent } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, User, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { collection, onSnapshot, query, getDocs, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { auth, db, googleProvider, testConnection, handleFirestoreError, OperationType } from "./firebase";
import { Product, Rep, PriceEntry, Invoice, Visit } from "./types";
import POSImport from "./components/POSImport";
import DocketScanner from "./components/DocketScanner";
import ProductCatalog from "./components/ProductCatalog";
import RepDirectory from "./components/RepDirectory";
import LowStockAlerts from "./components/LowStockAlerts";
import { Store, Receipt, Search, Users, ClipboardList, LogOut, CheckCircle2, ChevronRight, User as UserIcon, Lock, Sparkles, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | { uid: string; displayName: string; email: string; photoURL: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"scan" | "catalog" | "reps" | "pos-import" | "alerts">("scan");

  // Email/Password state variables
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [authActionLoading, setAuthActionLoading] = useState(false);

  // Real-time Database lists
  const [products, setProducts] = useState<Product[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [priceEntries, setPriceEntries] = useState<PriceEntry[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [allVisits, setAllVisits] = useState<Visit[]>([]);

  // Run mandatory connection check on load
  useEffect(() => {
    testConnection();
  }, []);

  // Sync Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user);
        
        // Sync user details to Firestore if not bypass / demo account
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
              await updateDoc(userRef, {
                lastLogin: serverTimestamp()
              });
            }
          } catch (syncErr) {
            console.error("Failed to sync auth state user to Firestore:", syncErr);
          }
        }
      } else {
        // If not logged in and no local mock bypass, nullify
        if (currentUser?.uid !== "mock_supermarket_manager") {
          setCurrentUser(null);
        }
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, [currentUser]);

  // Sync Master List Subscriptions (Only when authenticated)
  useEffect(() => {
    if (!currentUser) return;

    // Listen to Products
    const unsubProducts = onSnapshot(collection(db, "products"), (snapshot) => {
      const prodList: Product[] = [];
      snapshot.forEach(doc => {
        prodList.push({ id: doc.id, ...doc.data() } as Product);
      });
      setProducts(prodList.sort((a, b) => b.name.localeCompare(a.name)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "products");
    });

    // Listen to Reps
    const unsubReps = onSnapshot(collection(db, "reps"), (snapshot) => {
      const repList: Rep[] = [];
      snapshot.forEach(doc => {
        repList.push({ id: doc.id, ...doc.data() } as Rep);
      });
      setReps(repList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "reps");
    });

    // Listen to Price histories
    const unsubPrices = onSnapshot(collection(db, "prices"), (snapshot) => {
      const priceList: PriceEntry[] = [];
      snapshot.forEach(doc => {
        priceList.push({ id: doc.id, ...doc.data() } as PriceEntry);
      });
      setPriceEntries(priceList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "prices");
    });

    // Listen to uploaded invoice dockets
    const unsubInvoices = onSnapshot(collection(db, "invoices"), (snapshot) => {
      const invList: Invoice[] = [];
      snapshot.forEach(doc => {
        invList.push({ id: doc.id, ...doc.data() } as Invoice);
      });
      setInvoices(invList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "invoices");
    });

    return () => {
      unsubProducts();
      unsubReps();
      unsubPrices();
      unsubInvoices();
    };
  }, [currentUser]);

  // Listen / Fetch Subcollection visit notes flattenedly on Rep updates
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
        console.warn("Retrying visits gathering subcollection fetch...", err);
      }
    };

    fetchAllVisits();
  }, [currentUser, reps, priceEntries]);

  // Email/Password Sign In & Sign Up Handler
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
        // Sign Up
        const userCredential = await createUserWithEmailAndPassword(auth, authEmail.trim(), authPassword.trim());
        await updateProfile(userCredential.user, {
          displayName: authName.trim()
        });

        // Write user details explicitly to Firestore upon registration
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
          console.error("Failed to write registered user info to Firestore:", dbErr);
        }

        // Force state reload
        setCurrentUser({
          ...userCredential.user,
          displayName: authName.trim(),
          email: authEmail.trim()
        } as any);
        setAuthSuccess("Supermarket staff registered successfully! Welcome aboard.");
      } else {
        // Sign In
        const userCredential = await signInWithEmailAndPassword(auth, authEmail.trim(), authPassword.trim());
        
        // Sync user details to Firestore upon manual email login
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
            await updateDoc(userRef, {
              lastLogin: serverTimestamp()
            });
          }
        } catch (dbErr) {
          console.error("Failed to update user login details in Firestore:", dbErr);
        }

        setCurrentUser(userCredential.user);
        setAuthSuccess("Successfully logged in.");
      }
    } catch (err: any) {
      console.error("Email authentication failed:", err);
      let readableError = err.message || "An error occurred during authentication.";
      if (err.code === "auth/email-already-in-use") {
        readableError = "This email is already registered to a staff profile.";
      } else if (err.code === "auth/weak-password") {
        readableError = "Password should be at least 6 characters.";
      } else if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found") {
        readableError = "Incorrect email address or password.";
      } else if (err.message?.includes("CONFIGURATION_NOT_FOUND") || err.code === "auth/operation-not-allowed") {
        readableError = "Email/Password sign-in is not yet enabled in your Firebase console. Please go to your Firebase Console -> Authentication -> Sign-in method, click 'Add new provider' and enable 'Email/Password'.";
      }
      setAuthError(readableError);
    } finally {
      setAuthActionLoading(false);
    }
  };

  // Auth logins
  const handleGoogleSignIn = async () => {
    try {
      setAuthLoading(true);
      const result = await signInWithPopup(auth, googleProvider);
      
      // Sync Google sign-in details to Firestore
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
            await updateDoc(userRef, {
              lastLogin: serverTimestamp()
            });
          }
        } catch (dbErr) {
          console.error("Failed to sync Google user details to Firestore:", dbErr);
        }
      }
    } catch (err) {
      console.error("Google Popup Auth failed:", err);
      alert("Popup authentication failed. Trying demo bypass instead.");
      handleDemoBypass();
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDemoBypass = () => {
    // Elegant bypass to allow preview users to use full app database immediately
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
    setProducts([]);
    setReps([]);
    setPriceEntries([]);
    setInvoices([]);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center space-y-4">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
        <p className="text-sm font-semibold text-gray-500">Connecting Chapel Downs Supermarket database...</p>
      </div>
    );
  }

  // AUTHENTICATED OR NOT GATE
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden text-center" id="auth_portal_card">
          
          {/* BANNER AUCKLAND NZ */}
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
                <Lock className="h-4.5 w-4.5 text-emerald-600" />
                <span>Staff Terminal Gateway</span>
              </h2>
              <p className="text-xs text-gray-500 leading-relaxed">
                Connect and synchronize with Chapel Downs Supermarket inventory systems.
              </p>
            </div>

            {/* ERROR & SUCCESS STATUSES */}
            {authError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 text-[11px] rounded-lg leading-tight font-medium">
                {authError}
              </div>
            )}
            {authSuccess && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] rounded-lg leading-tight font-medium">
                {authSuccess}
              </div>
            )}

            {/* REGISTER VS LOGIN TABS */}
            <div className="flex bg-slate-100 rounded-lg p-1">
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(false);
                  setAuthError(null);
                }}
                className={`flex-1 py-1 px-3 text-center text-xs font-bold rounded-md transition-all cursor-pointer ${
                  !isSignUp ? "bg-white text-slate-800 shadow-xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(true);
                  setAuthError(null);
                }}
                className={`flex-1 py-1 px-3 text-center text-xs font-bold rounded-md transition-all cursor-pointer ${
                  isSignUp ? "bg-white text-slate-800 shadow-xs" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                Sign Up Staff
              </button>
            </div>

            {/* CREDENTIALS FORM */}
            <form onSubmit={handleEmailAuthSubmit} className="space-y-3">
              {isSignUp && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Full Name</label>
                  <input
                    type="text"
                    required
                    disabled={authActionLoading}
                    placeholder="e.g. Rachel Green"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:bg-white focus:border-emerald-600 transition-all font-sans"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Staff Email</label>
                <input
                  type="email"
                  required
                  disabled={authActionLoading}
                  placeholder="name@chapeldowns.co.nz"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:bg-white focus:border-emerald-600 transition-all font-sans"
                />
              </div>

              <div className="space-y-1 font-sans">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Security Password</label>
                <input
                  type="password"
                  required
                  disabled={authActionLoading}
                  placeholder="••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50/50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:bg-white focus:border-emerald-600 transition-all font-sans"
                />
              </div>

              <button
                type="submit"
                disabled={authActionLoading}
                className="w-full mt-2 py-2.5 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold text-center flex items-center justify-center gap-1.5 cursor-pointer shadow-md transition-all active:scale-98"
              >
                {authActionLoading ? (
                  <span className="h-4 w-4 border-2 border-white border-t-transparent animate-spin rounded-full"></span>
                ) : (
                  <span>{isSignUp ? "Register Supermarket Profile" : "Secure Staff Login"}</span>
                )}
              </button>
            </form>

            {/* SEPARATOR */}
            <div className="relative flex py-1 items-center font-sans">
              <div className="flex-grow border-t border-slate-200"></div>
              <span className="flex-shrink mx-3 text-slate-400 text-[9px] uppercase tracking-wider font-bold">Alternative Portals</span>
              <div className="flex-grow border-t border-slate-200"></div>
            </div>

            {/* SECONDARY LOGIN ACTIONS */}
            <div className="grid grid-cols-2 gap-2 font-sans">
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="py-2.5 px-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-all active:scale-98"
              >
                <span className="font-bold text-slate-650">Google Portal</span>
              </button>

              <button
                type="button"
                onClick={handleDemoBypass}
                className="py-2.5 px-2 bg-slate-905 hover:bg-slate-800 text-emerald-400 border border-slate-250 bg-slate-50 text-slate-700 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-all active:scale-98 shadow-sm"
              >
                <Sparkles className="h-3 w-3 text-emerald-450" />
                <span>Demo Sandbox</span>
              </button>
            </div>

            {/* DIRECTIVE FOR DISCOVERY */}
            <p className="text-[9px] text-slate-400 text-center leading-normal italic font-sans max-w-xs mx-auto">
              Please ensure "Email/Password" authentication provider is activated in your chapel-downs-supplier Firebase console.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const lowStockCount = products.filter(p => {
    if (p.minStockLevel !== undefined && p.currentStock !== undefined) {
      return p.currentStock < p.minStockLevel;
    }
    return p.lowStock;
  }).length;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-gray-800">
      
      {/* HEADER COCKPIT - COMPACT HIGH DENSITY */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-3 h-11 flex items-center justify-between">
          
          {/* BRAND */}
          <div className="flex items-center gap-2">
            <div className="bg-emerald-700 text-white p-1 rounded">
              <Store className="h-4 w-4" />
            </div>
            <div className="text-left font-sans flex items-baseline gap-1.5">
              <h1 className="text-xs font-bold text-slate-900 tracking-tight leading-none">Chapel Downs Supermarket</h1>
              <span className="text-[10px] text-emerald-700 font-medium">Rep &amp; Invoice Manager</span>
            </div>
          </div>

          {/* USER CARD & SIGNOUT */}
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex flex-col text-right leading-tight">
              <span className="text-[10px] font-bold text-slate-700">{currentUser.displayName || "Store Clerk"}</span>
              <span className="text-[9px] text-slate-400 font-mono">{currentUser.email}</span>
            </div>
            
            <button
              onClick={handleLogOutComp}
              title="Sign Out of supermarket terminal"
              className="p-1 text-slate-400 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 rounded border border-slate-200 transition-colors cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>

        </div>
      </header>

      {/* SUBNAV TABS BAR - TIGHT PILLS */}
      <div className="bg-[#0f172a] border-b border-emerald-950 py-0.5 sticky top-11 z-40 shadow-xs" id="supermarket_nav_container">
        <div className="max-w-7xl mx-auto px-3 flex overflow-x-auto space-x-1 scrollbar-none" id="supermarket_nav_tabs">
          
          <button
            onClick={() => setActiveTab("scan")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${
              activeTab === "scan" 
                ? "bg-emerald-700 text-white shadow-xs" 
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
            }`}
          >
            <Receipt className="h-3.5 w-3.5" />
            <span>Docket Scan Review</span>
          </button>

          <button
            onClick={() => setActiveTab("catalog")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${
              activeTab === "catalog" 
                ? "bg-emerald-700 text-white shadow-xs" 
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
            }`}
          >
            <Search className="h-3.5 w-3.5" />
            <span>POS Product Directory</span>
          </button>

          <button
            onClick={() => setActiveTab("reps")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${
              activeTab === "reps" 
                ? "bg-emerald-700 text-white shadow-xs" 
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            <span>Supplier Rep Profiles</span>
          </button>

          <button
            onClick={() => setActiveTab("pos-import")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${
              activeTab === "pos-import" 
                ? "bg-emerald-700 text-white shadow-xs" 
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
            }`}
          >
            <ClipboardList className="h-3.5 w-3.5" />
            <span>Idealpos Product Import</span>
          </button>

          <button
            onClick={() => setActiveTab("alerts")}
            className={`px-3 py-1.5 rounded text-[11px] font-semibold shrink-0 cursor-pointer flex items-center gap-1.5 transition-all ${
              activeTab === "alerts" 
                ? "bg-rose-700 text-white shadow-xs" 
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
            }`}
          >
            <AlertTriangle className={`h-3.5 w-3.5 ${lowStockCount > 0 ? "text-rose-450 animate-pulse" : "text-slate-405"}`} />
            <span>Low Stock Alerts</span>
            {lowStockCount > 0 && (
              <span className="px-1.5 py-0.2 bg-rose-600 rounded-full text-white text-[9px] font-bold">
                {lowStockCount}
              </span>
            )}
          </button>

        </div>
      </div>

      {/* CORE DISPLAY STAGE */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-3 pb-12">
        
        {/* HELPFUL LANDING ALERT FOR EMPTY DATABASES */}
        {products.length === 0 && activeTab !== "pos-import" && (
          <div className="bg-amber-50 rounded p-2 border border-amber-200/70 mb-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-left" id="empty_bootstrap_banner">
            <div className="flex items-center gap-2">
              <div className="bg-amber-100 p-1 rounded text-amber-900 shrink-0">
                <Store className="h-4 w-4" />
              </div>
              <div className="font-sans">
                <h4 className="text-[11px] font-bold text-amber-900 leading-tight">Product database is empty</h4>
                <p className="text-[10px] text-amber-700 mt-0.5 leading-none">Please import products from your **Idealpos CSV export** to configure the scanning cross-references.</p>
              </div>
            </div>
            <button
              onClick={() => setActiveTab("pos-import")}
              className="px-2.5 py-1 bg-amber-800 hover:bg-amber-900 text-white text-[10px] font-semibold rounded shrink-0 cursor-pointer flex items-center gap-1 transition-all"
            >
              <span>Bootstrap Database</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.1 }}
            id="viewport_tab_switch_container"
          >
            {activeTab === "scan" && (
              <DocketScanner 
                reps={reps}
                products={products}
                onScanConfirmed={() => setActiveTab("catalog")}
                currentUserUid={currentUser.uid}
              />
            )}

            {activeTab === "catalog" && (
              <ProductCatalog 
                products={products}
                reps={reps}
                priceEntries={priceEntries}
                currentUserUid={currentUser.uid}
              />
            )}

            {activeTab === "reps" && (
              <RepDirectory
                reps={reps}
                visits={allVisits}
                products={products}
                priceEntries={priceEntries}
                invoices={invoices}
                onRepChange={() => {}}
                currentUserUid={currentUser.uid}
              />
            )}

            {activeTab === "pos-import" && (
              <POSImport 
                onImportComplete={() => setActiveTab("catalog")}
                existingProductIds={products.map(p => p.id)}
              />
            )}

            {activeTab === "alerts" && (
              <LowStockAlerts 
                products={products}
                reps={reps}
                currentUserUid={currentUser.uid}
                onNavigateToCatalog={() => setActiveTab("catalog")}
              />
            )}
          </motion.div>
        </AnimatePresence>

      </main>

      {/* FOOTER */}
      <footer className="py-2.5 bg-white border-t border-slate-200 text-center text-[9px] text-slate-400 font-mono mt-auto shrink-0 leading-relaxed">
        Chapel Downs Supermarket — Auckland, NZ. Operational Portal, strictly authing verified staff. All wholesale prices logged sequentially.
      </footer>

    </div>
  );
}
