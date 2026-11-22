import _ from 'lodash';

export const removeKeys = (
  obj: Record<string, any>,
  keysToRemove: string[] = ['created_at', 'updated_at']
): Record<string, any> => {
  if (!_.isObject(obj)) return obj;
  if (_.isArray(obj)) return obj;

  return _.reduce(
    obj,
    (result, value, key) => {
      if (keysToRemove.includes(key)) return result;

      const valueIsNestedObject = _.isObject(value) && !_.isArray(value);
      if (valueIsNestedObject) result[key] = removeKeys(value, keysToRemove);
      else result[key] = value;
      return result;
    },
    {} as Record<string, any>
  );
};
