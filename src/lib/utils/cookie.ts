import type {Response} from "express";

export function setAuthCookie(res: Response, token: string, maxAgeSec: number) {
    res.cookie("access_token", token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: maxAgeSec * 1000,
        path: "/",
    });
}
