import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/trpc/routers';
import { createContext } from '@/server/trpc/context';

const allowedOrigins = new Set([
    'http://localhost:3000',
    'https://communities-three.vercel.app',
    'https://communities-git-pwa-fix-ranjan-bhats-projects.vercel.app',
    'https://communities-git-dev-ranjan-bhats-projects.vercel.app',
    ...(process.env.NEXT_PUBLIC_APP_URL
        ? [process.env.NEXT_PUBLIC_APP_URL]
        : []),
]);

export async function GET(req: Request) {
    const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: appRouter,
        createContext,
        onError({ error }) {
            if (error.code === 'UNAUTHORIZED') {
                console.error('UNAUTHORIZED', error);
            }
        },
    });

    // Add CORS headers
    const origin = req.headers.get('origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    if (origin && allowedOrigins.has(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
    }

    return response;
}

export { GET as POST };
