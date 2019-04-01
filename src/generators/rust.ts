import {
  IGenerator,
  TGetMethodTypingsMap,
  TGetFunctionSignature,
  IContentDescriptorTyping,
  IMethodTypingsMap,
} from "./generator-interface";
import _ from "lodash";
import { types } from "@open-rpc/meta-schema";
import { generateMethodParamId, generateMethodResultId } from "@open-rpc/schema-utils-js";
import { compile } from "json-schema-to-typescript";
import { quicktype, SchemaTypeSource, TypeSource } from "quicktype";
import { RegexLiteral } from "@babel/types";

import { inspect } from "util"; // for debugging

const getTypeName = (contentDescriptor: types.ContentDescriptorObject): string => {
  return _.chain(contentDescriptor.name).camelCase().upperFirst().value();
};

const getQuickTypeSources = (contentDescriptors: types.ContentDescriptorObject[]): SchemaTypeSource[] => {
  return _.chain(contentDescriptors)
    .map((contentDescriptor) => ({
      kind: "schema",
      name: getTypeName(contentDescriptor),
      schema: JSON.stringify(contentDescriptor.schema),
    } as SchemaTypeSource))
    .uniqBy("name")
    .value();
};

const getMethodTypingsMap: TGetMethodTypingsMap = async (openrpcSchema) => {
  const { methods } = openrpcSchema;

  const allContentDescriptors = [
    ..._.chain(methods).map("params").flatten().value(),
    ..._.map(methods, "result"),
  ] as types.ContentDescriptorObject[];

  //console.log("allContentDescriptors", inspect(allContentDescriptors));

  const deriveString = "#[derive(Serialize, Deserialize)]";
  const handyDeriveString = "#[derive(Debug, Clone, Serialize, Deserialize)]";
  const cfgDeriveString = "#[cfg_attr(test, derive(Random))]";
  const untaggedString = "#[serde(untagged)]";
  const typeLinesNested = await Promise.all(
    _.map(
      getQuickTypeSources(allContentDescriptors),
      (source) => quicktype({
        lang: "rust",
        leadingComments: undefined,
        rendererOptions: { "just-types": "true" },
        sources: [source],
      }).then(
        (result) => _.chain(result.lines)
          .filter((line) => !_.startsWith(line, "//"))
          // .forEach(console.log) // Uncomment to print every line of types quicktype produces. Worst api ever...
          .reduce((memoLines, line) => {
            const lastItem = _.last(memoLines);
            const interfaceMatch = line.match(/pub (struct|enum) (.*) {/);

            if (interfaceMatch) {
              const toAdd = [handyDeriveString, cfgDeriveString];

              if (interfaceMatch[1] === "enum") {
                toAdd.push(untaggedString);
              }

              toAdd.push(line);

              memoLines.push(toAdd);
            } else if (_.isArray(lastItem)) {
              lastItem.push(line);
              if (line === "}") {
                memoLines.push("");
              }
            } else {
              memoLines.push(line);
            }

            return memoLines;
          }, [] as any)
          .filter((line) => line !== untaggedString && line !== deriveString)
          .compact()
          .value(),
      ),
    ),
  );

  const typeLines = _.flatten(typeLinesNested);
  // console.log("typeLines", inspect(typeLines));

  const typeRegexes = {
    alias: /pub type (.*) = (.*)\;/,
    decleration: /use (.*)\;/,
    enum: /pub enum (.*) {/,
    struct: /pub struct (.*) {/,
  };

  const simpleTypes = _.filter(typeLines, (line) => typeof line === "string");
  //console.log("simpleTypes", inspect(simpleTypes));
  const complexTypes = _.difference(typeLines, simpleTypes);
  //console.log("complexTypes", inspect(complexTypes));

  const useDeclerationTypes = _.filter(simpleTypes, (line) => typeRegexes.decleration.test(line.toString()));
  const aliasTypes = _.filter(simpleTypes, (line) => typeRegexes.alias.test(line.toString()));
  const structTypes = _.filter(complexTypes, (lines: string[]) => _.some(lines, (l) => typeRegexes.struct.test(l)));
  const enumTypes = _.filter(complexTypes, (lines: string[]) => _.some(lines, (l) => typeRegexes.enum.test(l)));

  //console.log("useDeclerationTypes", inspect(useDeclerationTypes));
  //console.log("aliasTypes", inspect(aliasTypes));
  //console.log("structTypes", inspect(structTypes));
  //console.log("enumTypes", inspect(enumTypes));

  const uniqueStructTypes = _.uniqBy(structTypes, (lines: any) => {
    const regex = /pub (struct|enum) (.*) {/;
    const lineMatch = _.find(lines, (l) => regex.test(l));
    return lineMatch.match(regex)[2]; // typeName
  });

  //console.log("uniqueStructTypes", inspect(uniqueStructTypes));

  const allTypings = _.flatten([
    ...useDeclerationTypes,
    ...aliasTypes,
    ...enumTypes,
    ...uniqueStructTypes,
  ]).join("\n");

  const typings = _.chain(methods)
    .map((method) => {
      const r = [];
      const result = method.result as types.ContentDescriptorObject;
      const params = method.params as types.ContentDescriptorObject[];
      return [
        {
          typeId: generateMethodResultId(method, result),
          typeName: getTypeName(result),
          typing: "",
        },
        ..._.map(params, (param) => ({
          typeId: generateMethodParamId(method, param),
          typeName: getTypeName(param),
          typing: "",
        })),
      ];
    })
    .flatten()
    .keyBy("typeId")
    .value();

  typings[Object.keys(typings)[0]].typing += allTypings;
  //console.log(JSON.stringify(typings, undefined, "  "))
  //throw new Error();
  return typings;
};

const getFunctionSignature: TGetFunctionSignature = (method, typeDefs) => {
  const mResult = method.result as types.ContentDescriptorObject;
  const result = `RpcRequest<${typeDefs[generateMethodResultId(method, mResult)].typeName}>`;

  if (method.params.length === 0) {
    return `pub fn ${method.name}(&mut self) -> ${result};`;
  }

  const params = _.map(
    method.params as types.ContentDescriptorObject[],
    (param) => `${param.name}: ${typeDefs[generateMethodParamId(method, param)].typeName}`,
  ).join(", ");

  return `pub fn ${method.name}(&mut self, ${params}) -> ${result};`;
};

const generator: IGenerator = {
  getFunctionSignature,
  getMethodTypingsMap,
};

export default generator;
