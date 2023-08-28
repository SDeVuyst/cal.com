import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import prisma from "@calcom/prisma";

import { env } from "../../../env.mjs";
import { fetchAvailability } from "../../../tools/getAvailability";
import { fetchEventTypes } from "../../../tools/getEventTypes";
import { encrypt } from "../../../utils/encryption";
import host from "../../../utils/host";
import now from "../../../utils/now";
import sendEmail from "../../../utils/sendEmail";

/**
 * Verifies email signature and app authorization,
 * then hands off to booking agent.
 */
export const POST = async (request: NextRequest) => {
  const formData: any = await request.formData();
  const body = Object.fromEntries(formData);

  const signature = body.dkim;

  const envelope = JSON.parse(body.envelope);

  // Parse email from mixed MIME type
  const parsed: ParsedMail = await simpleParser(body.email);

  if (!parsed.text || !parsed.subject) {
    return new NextResponse("Email missing text or subject", { status: 400 });
  }

  const user = await prisma.user.findUnique({
    select: {
      email: true,
      id: true,
      credentials: {
        select: {
          appId: true,
          key: true,
        },
      },
    },
    where: { email: envelope.from },
  });

  if (!signature || !user?.email || !user?.id) {
    await sendEmail({
      subject: `Re: ${body.subject}`,
      text: "Sorry, you are not authorized to use this service. Please verify your email address and try again.",
      to: user?.email || "",
    });

    return new NextResponse();
  }

  // User has not installed the app from the app store. Direct them to install it.
  if (!user?.credentials.find((c) => c.appId === env.APP_ID)?.key) {
    const url = env.APP_URL;

    await sendEmail({
      html: `Thanks for using Cal AI! To get started, the app must be installed. <a href=${url} target="_blank">Click this link</a> to install it.`,
      subject: `Re: ${body.subject}`,
      text: `Thanks for using Cal AI! To get started, the app must be installed. Click this link to install the Cal AI app: ${url}`,
      to: envelope.from,
    });

    return new NextResponse("ok");
  }

  const { hash: apiKeyHashed, initVector: apiKeyIV } = encrypt(env.CAL_API_KEY);
  const userId = user.id.toString();

  // Pre-fetch data relevant to most bookings.
  const [eventTypes, availability] = await Promise.all([
    fetchEventTypes({
      apiKeyHashed,
      apiKeyIV,
      userId,
    }),
    fetchAvailability({
      apiKeyHashed,
      apiKeyIV,
      dateFrom: now,
      dateTo: now,
      userId,
    }),
  ]);

  const { timeZone, workingHours } = availability;

  const appHost = host(request.headers);

  // Hand off to long-running agent endpoint to handle the email.
  fetch(`${appHost}/api/agent`, {
    body: JSON.stringify({
      message: parsed.text,
      subject: parsed.subject,
      user: {
        id: userId,
        email: user.email,
        apiKeyHashed,
        apiKeyIV,
        eventTypes,
        timeZone,
        workingHours,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  await new Promise((r) => setTimeout(r, 1000));

  return new NextResponse("ok");
};
