/**
 * Custom function for the Google Sheet to calculate the number of columns in r1c1 notation
 *
 * @param {string} ranges - string with r1c1 notation
 * @return {int} number of columns beetween srart and end column 
 */

function columnsFromRange(a1Notation) {
  // Locale function for the reduce callback
  function getColumnNumber_(acc, value, index, array) {
    var charCode = array.join("").charCodeAt(index) - 64
    acc += charCode * Math.pow(26, array.length - (index + 1))
    return acc
  }

  if (a1Notation.map) {            // Test whether input is an array to use with an ArrayFormula

    //Recursive use of the same function os the array 
    return a1Notation.map(columnsFromRange); // Recurse over array if so.
  }

  else {
    if (a1Notation) {

      // Split Start and End of the range
      a1notation = a1Notation.split(":");

      // Regex to extract columns (letters), rows (digits)
      try {
        var columnStart = a1notation?.[0].match(/[A-Z]+/)[0];
        var columnEnd = a1notation?.[1]?.match(/[A-Z]+/)?.[0] || "";
      }

      catch { throw new Error(`Check r1c1 notation correctness`) }

      // Identify columnStart and End using reduce
      columnStart = columnStart.toUpperCase().split("").reduce(getColumnNumber_, 0) - 1
      columnEnd = columnEnd.toUpperCase().split("").reduce(getColumnNumber_, 0) - columnStart || ""

      return columnEnd
    }
    return ""
  }
}
