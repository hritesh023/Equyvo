import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    // Log the bad route for diagnostics; do not throw.
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn(`404 — no route for ${location.pathname}`);
    }
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center px-4">
        <h1 className="text-4xl font-bold mb-4">404</h1>
        <p className="text-xl text-muted-foreground mb-2">Oops! Page not found</p>
        <p className="text-sm text-muted-foreground mb-4 font-mono break-all">
          {location.pathname}
        </p>
        <Link to="/app/home" className="text-primary hover:underline underline-offset-4">
          Return to Home
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
