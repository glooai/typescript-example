/**
 * Ambient declaration for the `awslambda` global that the Node.js Lambda
 * runtime injects when a function is invoked through a Function URL in
 * RESPONSE_STREAM mode. AWS ships no types for it, so we declare the two
 * members we use.
 */
import type { LambdaFunctionURLEvent, Context } from "aws-lambda";
import type { Writable } from "node:stream";

export type ResponseStream = Writable & {
  setContentType(contentType: string): void;
};

declare global {
  const awslambda: {
    streamifyResponse(
      handler: (
        event: LambdaFunctionURLEvent,
        responseStream: ResponseStream,
        context: Context
      ) => Promise<void>
    ): unknown;
    HttpResponseStream: {
      from(
        stream: ResponseStream,
        metadata: {
          statusCode: number;
          headers?: Record<string, string>;
        }
      ): ResponseStream;
    };
  };
}
